import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import {
  createDatabase,
  events,
  feedbackCampaigns,
  feedbackConversationExecutions,
  feedbackConversations,
  messageOutbox,
  participants,
  type AppDatabase,
  type AppTransaction,
  type DatabaseClient,
} from "@slopform/database";
import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { DatabaseService } from "../../infrastructure/database/database.service.js";
import { ConversationPersistenceError } from "../conversations/conversation-persistence.errors.js";
import { POST_EVENT_FEEDBACK_SAFETY_CATEGORIES } from "./attention.js";
import { FeedbackConversationExecutionFenceRepository } from "./extraction/execution-fence.repository.js";
import {
  FEEDBACK_CONVERSATION_MAX_MESSAGES_BYTES,
  type FeedbackConversationMessage,
  deriveFeedbackConversationId,
} from "./post-event-feedback-conversation.document.js";
import {
  FeedbackConversationCapacityError,
  FeedbackConversationNotFoundError,
  FeedbackConversationPhoneConflictError,
  FeedbackConversationRepository,
  FeedbackConversationTransitionError,
} from "./post-event-feedback-conversation.repository.js";

const campaignId = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const respondentParticipantId = "9f3c1a52-6e2b-4b4a-9a17-2cb2a6d13a55";
const conversationId = deriveFeedbackConversationId(
  campaignId,
  respondentParticipantId,
);
const phoneAtLaunch = "+306900000000";
const launchedAt = new Date("2026-07-25T10:00:00.000Z");
const repliedAt = new Date("2026-07-25T10:05:00.000Z");
const outboxId = "d4a4b3c2-8f1e-4d3c-9b2a-1e0f9d8c7b6a";
const messageId = "5c7e6f10-3a2b-4c1d-8e9f-0a1b2c3d4e5f";
const eventId = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

// Explicit disposable database only; never use the application DATABASE_URL.
const postgresTestUrl = process.env.FEEDBACK_POSTGRES_TEST_URL;

describe("FeedbackConversationRepository", () => {
  it("does not query when the extraction-accounting scope is empty", async () => {
    const repository = createRepository(unavailableDatabase());
    await expect(
      repository.listExtractionAccountingForCampaigns([]),
    ).resolves.toEqual([]);
  });

  it("does not query when the lifecycle-statistics page is empty", async () => {
    const repository = createRepository(unavailableDatabase());
    await expect(
      repository.listLifecycleStatsForCampaigns([]),
    ).resolves.toEqual([]);
  });

  it("does not query when the respondent id list is empty", async () => {
    const repository = createRepository(unavailableDatabase());
    await expect(repository.listRespondentsByIds([])).resolves.toEqual([]);
  });

  it("requires an idempotency key before touching storage", async () => {
    const repository = createRepository(unavailableDatabase());
    await expect(
      repository.appendMessage(unavailableTransaction(), {
        conversationId,
        actor: "system",
        text: "hello",
        at: repliedAt,
      }),
    ).rejects.toBeInstanceOf(ConversationPersistenceError);
  });
});

const describePostgres = postgresTestUrl ? describe : describe.skip;

describePostgres("FeedbackConversationRepository PostgreSQL adapter", () => {
  let client: DatabaseClient;
  let repository: FeedbackConversationRepository;

  beforeAll(async () => {
    if (!postgresTestUrl) {
      return;
    }
    client = createDatabase({
      applicationName: "feedback-conversation-storage-test",
      connectionString: postgresTestUrl,
      maxConnections: 4,
    });
    await migrate(client.db, {
      migrationsFolder: fileURLToPath(
        new URL("../../../../../packages/database/drizzle", import.meta.url),
      ),
    });
    repository = createRepository(client.db);
  });

  afterAll(async () => {
    await client?.pool.end();
  });

  it("creates the launch document under a deterministic id with durable work fields", async () => {
    await withRolledBackTx(client.db, async (tx) => {
      await seedParents(tx);
      const result = await repository.createFromLaunch(tx, {
        campaignId,
        respondentParticipantId,
        phoneAtLaunch,
        launchedAt,
      });
      expect(result).toEqual({
        created: true,
        conversation: expect.objectContaining({
          _id: conversationId,
          schemaVersion: 2,
          purpose: "post_event_feedback",
          channel: "whatsapp",
          lifecycle: expect.objectContaining({
            state: "open",
            reason: null,
            closedAt: null,
          }),
          control: { mode: "bot", source: "launch", changedAt: launchedAt },
          extraction: expect.objectContaining({
            cursorSeq: 0,
            lastRunAt: null,
            model: null,
            usage: null,
            serviceTier: null,
            parkedSince: null,
            parkedRuns: 0,
            parkedNoticeSentAt: null,
          }),
          work: expect.objectContaining({
            revision: 0,
            nextActionAt: null,
            executionEpoch: 0,
          }),
          needsAttention: false,
          attentionReasons: [],
        }),
      });
      expect(result.conversation.goals.map((goal) => goal.key)).toEqual([
        "event_score",
        "table_fit",
        "participation_ease",
        "conversation_balance",
        "meet_again",
        "avoid",
      ]);
    });
  });

  it("replays a launch idempotently and never recreates a stopped conversation", async () => {
    await withRolledBackTx(client.db, async (tx) => {
      await seedParents(tx);
      await repository.createFromLaunch(tx, launchInput());
      await repository.close(tx, {
        conversationId,
        reason: "stopped",
        at: repliedAt,
        terminalOutboxId: outboxId,
      });
      const replay = await repository.createFromLaunch(tx, launchInput());
      expect(replay.created).toBe(false);
      expect(replay.conversation.lifecycle).toMatchObject({
        reason: "stopped",
      });
    });
  });

  it("reports a phone conflict when another open conversation owns the number", async () => {
    await withRolledBackTx(client.db, async (tx) => {
      await seedParents(tx);
      const otherParticipant = randomUUID();
      await tx.insert(participants).values({
        id: otherParticipant,
        emailNormalized: "other-respondent@example.com",
      });
      await repository.createFromLaunch(tx, launchInput());
      await expect(
        repository.createFromLaunch(tx, {
          campaignId,
          respondentParticipantId: otherParticipant,
          phoneAtLaunch,
          launchedAt,
        }),
      ).rejects.toBeInstanceOf(FeedbackConversationPhoneConflictError);
    });
  });

  it("authorizes only the terminal outbox id paired to its own conversation", async () => {
    await withRolledBackTx(client.db, async (tx) => {
      await seedParents(tx);
      await repository.createFromLaunch(tx, launchInput());
      await repository.close(tx, {
        conversationId,
        reason: "stopped",
        at: repliedAt,
        terminalOutboxId: outboxId,
      });
      const otherConversationId = "f0562a6b-d334-43f0-a029-43298a559ac0";
      const otherOutboxId = "14b0d0f3-8cf0-4420-ae96-8eb77a21915e";
      await expect(
        repository.listCurrentTerminalOutboxIds(
          [
            { conversationId, outboxId },
            { conversationId: otherConversationId, outboxId: otherOutboxId },
            { conversationId, outboxId: otherOutboxId },
          ],
          tx,
        ),
      ).resolves.toEqual([outboxId]);
    });
  });

  it("projects exact STOP terminal ids for campaign-close preservation", async () => {
    await withRolledBackTx(client.db, async (tx) => {
      await seedParents(tx);
      await repository.createFromLaunch(tx, launchInput());
      await repository.close(tx, {
        conversationId,
        reason: "stopped",
        at: repliedAt,
        terminalOutboxId: outboxId,
      });
      await expect(
        repository.listStopTerminalOutboxIdsForCampaign(campaignId, tx),
      ).resolves.toEqual([outboxId]);
    });
  });

  it("resolves inbound traffic through the open-phone index", async () => {
    await withRolledBackTx(client.db, async (tx) => {
      await seedParents(tx);
      await repository.createFromLaunch(tx, launchInput());
      const found = await repository.findOpenByPhone(phoneAtLaunch, tx);
      expect(found?._id).toBe(conversationId);
    });
  });

  it("appends a message with a contiguous sequence and observed-time order", async () => {
    await withRolledBackTx(client.db, async (tx) => {
      await seedParents(tx);
      await repository.createFromLaunch(tx, launchInput());
      const later = await repository.appendMessage(tx, {
        conversationId,
        actor: "participant",
        text: "δεύτερο",
        at: repliedAt,
        ingressId: randomUUID(),
        id: messageId,
      });
      expect(later.appended).toBe(true);
      expect(later.message.seq).toBe(1);
      const earlierAt = new Date("2026-07-25T10:01:00.000Z");
      const earlier = await repository.appendMessage(tx, {
        conversationId,
        actor: "participant",
        text: "πρώτο",
        at: earlierAt,
        ingressId: randomUUID(),
      });
      expect(earlier.message.seq).toBe(2);
      expect(
        earlier.conversation.messages.map((message) => message.seq),
      ).toEqual([2, 1]);
    });
  });

  it("treats a replayed ingress append as an idempotent no-op", async () => {
    await withRolledBackTx(client.db, async (tx) => {
      await seedParents(tx);
      await repository.createFromLaunch(tx, launchInput());
      const ingressId = randomUUID();
      const first = await repository.appendMessage(tx, {
        conversationId,
        actor: "participant",
        text: "Πέρασα τέλεια!",
        at: repliedAt,
        ingressId,
      });
      const replay = await repository.appendMessage(tx, {
        conversationId,
        actor: "participant",
        text: "Πέρασα τέλεια!",
        at: repliedAt,
        ingressId,
      });
      expect(replay).toEqual({
        appended: false,
        message: first.message,
        conversation: expect.objectContaining({
          messages: [first.message],
        }),
      });
    });
  });

  it("rejects a replayed provenance id carrying different content", async () => {
    await withRolledBackTx(client.db, async (tx) => {
      await seedParents(tx);
      await repository.createFromLaunch(tx, launchInput());
      const ingressId = randomUUID();
      await repository.appendMessage(tx, {
        conversationId,
        actor: "participant",
        text: "Πέρασα τέλεια!",
        at: repliedAt,
        ingressId,
      });
      await expect(
        repository.appendMessage(tx, {
          conversationId,
          actor: "participant",
          text: "άλλαξε",
          at: repliedAt,
          ingressId,
        }),
      ).rejects.toBeInstanceOf(ConversationPersistenceError);
    });
  });

  it("names transcript_full when JSON text fits 4 MiB but jsonb storage does not", async () => {
    await withRolledBackTx(client.db, async (tx) => {
      await seedParents(tx);
      await repository.createFromLaunch(tx, launchInput());
      const messageCount = 80;
      const textLen = largestTextLenWithJsonUnderLimit(messageCount);
      const stored = Array.from({ length: messageCount }, (_, index) =>
        storedParticipantJson(index + 1, textLen),
      );
      const jsonText = JSON.stringify(stored);
      expect(Buffer.byteLength(jsonText, "utf8")).toBeLessThanOrEqual(
        FEEDBACK_CONVERSATION_MAX_MESSAGES_BYTES,
      );
      const measured = await tx.execute<{ size: number }>(
        sql`select pg_column_size(cast(${jsonText} as jsonb))::int as size`,
      );
      expect(Number(measured.rows[0]?.size)).toBeGreaterThan(
        FEEDBACK_CONVERSATION_MAX_MESSAGES_BYTES,
      );

      await tx
        .update(feedbackConversations)
        .set({
          messages: stored.slice(0, messageCount - 1),
          updatedAt: repliedAt,
        })
        .where(eq(feedbackConversations.id, conversationId));

      const last = stored[messageCount - 1];
      await expect(
        repository.appendMessage(tx, {
          conversationId,
          actor: "participant",
          text: last!.text,
          at: repliedAt,
          ingressId: last!.ingressId,
          id: last!.id,
        }),
      ).rejects.toBeInstanceOf(FeedbackConversationCapacityError);

      const current = await repository.findById(conversationId, tx);
      expect(current?.messages).toHaveLength(messageCount - 1);
      expect(current?.needsAttention).toBe(true);
      expect(
        current?.attentionReasons.some(
          (reason) => reason.kind === "transcript_full",
        ),
      ).toBe(true);
    });
  });

  it("names transcript_full when attention growth crosses jsonb capacity", async () => {
    await withRolledBackTx(client.db, async (tx) => {
      await seedParents(tx);
      await repository.createFromLaunch(tx, launchInput());
      const messageCount = 80;
      const textLen = await largestTextLenWithPgUnderLimit(tx, messageCount);
      const stored = Array.from({ length: messageCount }, (_, index) =>
        storedParticipantJson(index + 1, textLen),
      );
      const grown = withFullMessageAttention(stored);
      expect(
        Buffer.byteLength(JSON.stringify(grown), "utf8"),
      ).toBeLessThanOrEqual(FEEDBACK_CONVERSATION_MAX_MESSAGES_BYTES);
      expect(await pgColumnSize(tx, stored)).toBeLessThanOrEqual(
        FEEDBACK_CONVERSATION_MAX_MESSAGES_BYTES,
      );
      expect(await pgColumnSize(tx, grown)).toBeGreaterThan(
        FEEDBACK_CONVERSATION_MAX_MESSAGES_BYTES,
      );

      await tx
        .update(feedbackConversations)
        .set({ messages: stored, updatedAt: repliedAt })
        .where(eq(feedbackConversations.id, conversationId));

      await expect(
        repository.mergeMessageAttention(tx, {
          conversationId,
          messageId: stored[0]!.id,
          categories: POST_EVENT_FEEDBACK_SAFETY_CATEGORIES,
          recommendedAction: "urgent_human_follow_up",
          confidence: 0.99,
          at: repliedAt,
        }),
      ).rejects.toBeInstanceOf(FeedbackConversationCapacityError);

      const current = await repository.findById(conversationId, tx);
      expect(current?.messages).toHaveLength(messageCount);
      expect(current?.messages[0]?.attention).toBeNull();
      expect(current?.needsAttention).toBe(true);
      expect(
        current?.attentionReasons.some(
          (reason) => reason.kind === "transcript_full",
        ),
      ).toBe(true);
    });
  });

  it("names the raise instead of dropping a message at the transcript cap", async () => {
    await withRolledBackTx(client.db, async (tx) => {
      await seedParents(tx);
      await repository.createFromLaunch(tx, launchInput());
      for (let seq = 1; seq <= 150; seq += 1) {
        await repository.appendMessage(tx, {
          conversationId,
          actor: "participant",
          text: `μήνυμα ${seq}`,
          at: new Date(launchedAt.getTime() + seq * 1000),
          ingressId: randomUUID(),
        });
      }
      await expect(
        repository.appendMessage(tx, {
          conversationId,
          actor: "participant",
          text: "one more",
          at: repliedAt,
          ingressId: randomUUID(),
        }),
      ).rejects.toBeInstanceOf(FeedbackConversationCapacityError);
      const current = await repository.findById(conversationId, tx);
      expect(current?.needsAttention).toBe(true);
      expect(
        current?.attentionReasons.some(
          (reason) => reason.kind === "transcript_full",
        ),
      ).toBe(true);
    });
  });

  it("marks durable work due and campaign open rows in one SQL update", async () => {
    await withRolledBackTx(client.db, async (tx) => {
      await seedParents(tx);
      await repository.createFromLaunch(tx, launchInput());
      const nextActionAt = new Date("2026-07-25T10:06:00.000Z");
      const due = await repository.markWorkDue(tx, {
        conversationId,
        nextActionAt,
        at: repliedAt,
      });
      expect(due).toMatchObject({
        changed: true,
        work: { revision: 1, nextActionAt, executionEpoch: 0 },
      });
      const campaignDue = await repository.markCampaignWorkDue(tx, {
        campaignId,
        nextActionAt: new Date("2026-07-25T10:07:00.000Z"),
        at: repliedAt,
      });
      expect(campaignDue).toBe(1);
      const current = await repository.findById(conversationId, tx);
      expect(current?.work?.revision).toBe(2);
    });
  });

  it("lists due work oldest-first, including terminal rows that need a cheap settlement", async () => {
    await withRolledBackTx(client.db, async (tx) => {
      await seedParents(tx);
      await repository.createFromLaunch(tx, launchInput());
      await repository.markWorkDue(tx, {
        conversationId,
        nextActionAt: repliedAt,
        at: repliedAt,
      });
      await repository.close(tx, {
        conversationId,
        reason: "completed",
        at: repliedAt,
      });
      const due = await repository.listDueWork(
        { dueAt: new Date("2026-07-25T11:00:00.000Z"), limit: 25 },
        tx,
      );
      expect(due).toHaveLength(1);
      expect(due[0]?.lifecycle.state).toBe("closed");
      expect(due[0]?.work?.nextActionAt).toEqual(repliedAt);
    });
  });

  it("continues a due-work scan after the exact date and conversation key", async () => {
    await withRolledBackTx(client.db, async (tx) => {
      await seedParents(tx);
      await repository.createFromLaunch(tx, launchInput());
      await repository.markWorkDue(tx, {
        conversationId,
        nextActionAt: repliedAt,
        at: repliedAt,
      });
      await expect(
        repository.listDueWork(
          {
            dueAt: new Date("2026-07-25T11:00:00.000Z"),
            limit: 100,
            campaignId,
            after: { nextActionAt: repliedAt, conversationId },
          },
          tx,
        ),
      ).resolves.toEqual([]);
    });
  });

  it("derives work.executionEpoch from the fence row and never invents 0 for a claimed fence", async () => {
    await withRolledBackTx(client.db, async (tx) => {
      await seedParents(tx);
      await repository.createFromLaunch(tx, launchInput());
      await tx.insert(feedbackConversationExecutions).values({
        conversationId,
        epoch: 8,
        workRevision: 1,
      });
      const loaded = await repository.findById(conversationId, tx);
      expect(loaded?.work?.executionEpoch).toBe(8);
      const locked = await repository.findByIdForUpdate(tx, conversationId);
      expect(locked?.work?.executionEpoch).toBe(8);
    });
  });

  it("admits a paid cursor when the joined fence epoch is still 0", async () => {
    await withRolledBackTx(client.db, async (tx) => {
      await seedParents(tx);
      await repository.createFromLaunch(tx, launchInput());
      await tx.insert(feedbackConversationExecutions).values({
        conversationId,
        epoch: 0,
        workRevision: 0,
      });
      await repository.appendMessage(tx, participantAppend());
      const result = await repository.advanceCursor(tx, {
        conversationId,
        toSeq: 1,
        at: repliedAt,
        workRevision: 0,
        executionEpoch: 0,
      });
      expect(result.changed).toBe(true);
      expect(result.conversation.extraction.cursorSeq).toBe(1);
      expect(result.conversation.work?.executionEpoch).toBe(0);
    });
  });

  it("does not admit a paid cursor when the fence row is missing", async () => {
    await withRolledBackTx(client.db, async (tx) => {
      await seedParents(tx);
      await repository.createFromLaunch(tx, launchInput());
      await repository.appendMessage(tx, participantAppend());
      const result = await repository.advanceCursor(tx, {
        conversationId,
        toSeq: 1,
        at: repliedAt,
        workRevision: 0,
        executionEpoch: 3,
      });
      expect(result.changed).toBe(false);
      expect(result.conversation.extraction.cursorSeq).toBe(0);
    });
  });

  it("settles a matching revision and leaves a newer schedule byte-for-byte", async () => {
    await withRolledBackTx(client.db, async (tx) => {
      await seedParents(tx);
      await repository.createFromLaunch(tx, launchInput());
      await repository.markWorkDue(tx, {
        conversationId,
        nextActionAt: repliedAt,
        at: repliedAt,
      });
      const newerDue = new Date("2026-07-25T10:07:00.000Z");
      await repository.markWorkDue(tx, {
        conversationId,
        nextActionAt: newerDue,
        at: repliedAt,
      });
      const settled = await repository.settleWorkExecution(tx, {
        conversationId,
        revision: 1,
        epoch: 11,
        nextActionAt: null,
        at: repliedAt,
      });
      expect(settled.changed).toBe(false);
      expect(settled.work.nextActionAt).toEqual(newerDue);
      const cleared = await repository.settleWorkExecution(tx, {
        conversationId,
        revision: 2,
        epoch: 11,
        nextActionAt: null,
        at: repliedAt,
      });
      expect(cleared.changed).toBe(true);
      expect(cleared.work).toMatchObject({
        revision: 2,
        nextActionAt: null,
      });
    });
  });

  it("projects durable extraction accounting without loading transcripts", async () => {
    await withRolledBackTx(client.db, async (tx) => {
      await seedParents(tx);
      await repository.createFromLaunch(tx, launchInput());
      await repository.appendMessage(tx, participantAppend());
      await repository.advanceCursor(tx, {
        conversationId,
        toSeq: 1,
        at: repliedAt,
        model: "openai/gpt-5.6-terra",
        serviceTier: "priority",
        usage: { inputTokens: 1_200, outputTokens: 200, totalTokens: 1_400 },
      });
      await expect(
        repository.listExtractionAccountingForCampaigns(
          [campaignId, campaignId],
          tx,
        ),
      ).resolves.toEqual([
        {
          conversationId,
          extraction: {
            model: "openai/gpt-5.6-terra",
            usage: {
              inputTokens: 1_200,
              outputTokens: 200,
              totalTokens: 1_400,
            },
            serviceTier: "priority",
          },
        },
      ]);
    });
  });

  it("projects a compact campaign list without transcripts", async () => {
    await withRolledBackTx(client.db, async (tx) => {
      await seedParents(tx);
      await repository.createFromLaunch(tx, launchInput());
      await repository.appendMessage(tx, participantAppend());
      const [summary] = await repository.listForCampaign(campaignId, 10, tx);
      expect(summary).toMatchObject({
        _id: conversationId,
        messageCount: 1,
        lastMessageActor: "participant",
        extractionParked: false,
      });
      expect(summary?.goals[0]).not.toHaveProperty("prompt");
    });
  });

  it("aggregates platform-wide overview conversation counters", async () => {
    await withRolledBackTx(client.db, async (tx) => {
      await seedParents(tx);
      await repository.createFromLaunch(tx, launchInput());
      await repository.raiseAttention(tx, {
        conversationId,
        kind: "handoff",
        messageId: null,
        at: repliedAt,
      });
      const stats = await repository.aggregateOverviewStats(tx);
      expect(stats.open).toBeGreaterThanOrEqual(1);
      expect(stats.needsAttention).toBeGreaterThanOrEqual(1);
      expect(
        stats.attentionByReason.some((entry) => entry.reason === "handoff"),
      ).toBe(true);
    });
  });

  it("groups lifecycle statistics for a bounded campaign repair page", async () => {
    await withRolledBackTx(client.db, async (tx) => {
      await seedParents(tx);
      await repository.createFromLaunch(tx, launchInput());
      await expect(
        repository.listLifecycleStatsForCampaigns([campaignId], tx),
      ).resolves.toEqual([
        {
          campaignId,
          totalCount: 1,
          openCount: 1,
          latestClosedAt: null,
        },
      ]);
    });
  });

  it("never resumes bot control on a closed conversation", async () => {
    await withRolledBackTx(client.db, async (tx) => {
      await seedParents(tx);
      await repository.createFromLaunch(tx, launchInput());
      await repository.takeOver(tx, {
        conversationId,
        source: "staff_action",
        at: repliedAt,
      });
      await repository.close(tx, {
        conversationId,
        reason: "cancelled",
        at: repliedAt,
      });
      await expect(
        repository.resumeBot(tx, { conversationId, at: repliedAt }),
      ).rejects.toBeInstanceOf(FeedbackConversationTransitionError);
    });
  });

  it("reports a missing conversation instead of inventing one", async () => {
    await withRolledBackTx(client.db, async (tx) => {
      await seedParents(tx);
      await expect(
        repository.raiseAttention(tx, {
          conversationId,
          kind: "safety",
          messageId,
          at: repliedAt,
        }),
      ).rejects.toBeInstanceOf(FeedbackConversationNotFoundError);
    });
  });

  it("rolls back the conversation, outbound intent and transcript together", async () => {
    await withCommittedParents(client.db, async () => {
      const failure = new Error("fail after transcript");
      await expect(
        client.db.transaction(async (tx) => {
          await repository.createFromLaunch(tx, launchInput());
          await tx.insert(messageOutbox).values({
            id: outboxId,
            campaignId,
            conversationId,
            kind: "intro",
            body: "hello",
            dedupeKey: `storage-${conversationId}`,
            dispatchContext: { schemaVersion: 1, purpose: "campaign_intro" },
          });
          await repository.appendMessage(tx, {
            conversationId,
            actor: "bot",
            text: "hello",
            outboxId,
            at: repliedAt,
          });
          throw failure;
        }),
      ).rejects.toBe(failure);
      expect(await repository.findById(conversationId)).toBeUndefined();
      expect(
        await client.db
          .select()
          .from(messageOutbox)
          .where(eq(messageOutbox.id, outboxId)),
      ).toEqual([]);
    });
  });

  it("serializes concurrent appends without dropping or duplicating arrival sequences", async () => {
    await withCommittedParents(client.db, async () => {
      await client.db.transaction((tx) =>
        repository.createFromLaunch(tx, launchInput()),
      );
      const append = (index: number) =>
        client.db.transaction((tx) =>
          repository.appendMessage(tx, {
            conversationId,
            actor: "participant",
            text: `concurrent ${index}`,
            at: repliedAt,
            ingressId: randomUUID(),
          }),
        );
      await Promise.all(
        Array.from({ length: 12 }, (_, index) => append(index)),
      );
      const stored = await repository.findById(conversationId);
      expect(stored?.messages.map((message) => message.seq)).toEqual(
        Array.from({ length: 12 }, (_, index) => index + 1),
      );
      expect(
        new Set(stored?.messages.map((message) => message.text)).size,
      ).toBe(12);
    });
  });

  it("rejects an expired owner's claim after the same revision is reclaimed", async () => {
    await withRolledBackTx(client.db, async (tx) => {
      await seedParents(tx);
      await repository.createFromLaunch(tx, launchInput());
      const fences = new FeedbackConversationExecutionFenceRepository();
      const first = await fences.tryClaim(tx, {
        conversationId,
        workRevision: 0,
        leaseMs: 60_000,
      });
      expect(first).toBeDefined();
      await tx
        .update(feedbackConversationExecutions)
        .set({ leaseUntil: sql`clock_timestamp() - interval '1 second'` })
        .where(
          eq(feedbackConversationExecutions.conversationId, conversationId),
        );
      const successor = await fences.tryClaim(tx, {
        conversationId,
        workRevision: 0,
        leaseMs: 60_000,
      });
      expect(successor?.epoch).toBe(first!.epoch + 1);
      expect(await fences.isCurrent(tx, first!)).toBe(false);
      expect(await fences.renew(tx, first!, 60_000)).toBeUndefined();
      expect(await fences.isCurrent(tx, successor!)).toBe(true);
    });
  });
});

async function withCommittedParents(
  db: AppDatabase,
  work: () => Promise<void>,
): Promise<void> {
  await db.transaction(seedParents);
  try {
    await work();
  } finally {
    await db.transaction(async (tx) => {
      await tx
        .delete(messageOutbox)
        .where(eq(messageOutbox.conversationId, conversationId));
      await tx
        .delete(feedbackConversationExecutions)
        .where(
          eq(feedbackConversationExecutions.conversationId, conversationId),
        );
      await tx
        .delete(feedbackConversations)
        .where(eq(feedbackConversations.id, conversationId));
      await tx
        .delete(feedbackCampaigns)
        .where(eq(feedbackCampaigns.id, campaignId));
      await tx.delete(events).where(eq(events.id, eventId));
      await tx
        .delete(participants)
        .where(eq(participants.id, respondentParticipantId));
    });
  }
}

class Rollback extends Error {
  constructor() {
    super("rollback");
    this.name = "Rollback";
  }
}

function createRepository(db: AppDatabase): FeedbackConversationRepository {
  return new FeedbackConversationRepository({ db } as DatabaseService);
}

function unavailableDatabase(): AppDatabase {
  return new Proxy({} as AppDatabase, {
    get() {
      throw new Error("PostgreSQL should not be opened for this case");
    },
  });
}

function unavailableTransaction(): AppTransaction {
  return new Proxy({} as AppTransaction, {
    get() {
      throw new Error("PostgreSQL should not be opened for this case");
    },
  });
}

async function withRolledBackTx(
  db: AppDatabase,
  work: (transaction: AppTransaction) => Promise<void>,
): Promise<void> {
  try {
    await db.transaction(async (transaction) => {
      await work(transaction);
      throw new Rollback();
    });
  } catch (error) {
    if (!(error instanceof Rollback)) {
      throw error;
    }
  }
}

async function seedParents(transaction: AppTransaction): Promise<void> {
  await transaction.insert(participants).values({
    id: respondentParticipantId,
    emailNormalized: "storage-respondent@example.com",
  });
  await transaction.insert(events).values({
    id: eventId,
    title: "Feedback storage test",
    startsAt: launchedAt,
    status: "finished",
  });
  await transaction.insert(feedbackCampaigns).values({
    id: campaignId,
    eventId,
    questionSetVersion: 2,
    questions: { version: 2 },
    launchedAt,
    launchedBy: "storage-test",
  });
}

function launchInput(): {
  readonly campaignId: string;
  readonly respondentParticipantId: string;
  readonly phoneAtLaunch: string;
  readonly launchedAt: Date;
} {
  return {
    campaignId,
    respondentParticipantId,
    phoneAtLaunch,
    launchedAt,
  };
}

function participantAppend(): {
  readonly conversationId: string;
  readonly actor: FeedbackConversationMessage["actor"];
  readonly text: string;
  readonly at: Date;
  readonly ingressId: string;
  readonly id: string;
} {
  return {
    conversationId,
    actor: "participant",
    text: "Πέρασα τέλεια!",
    at: repliedAt,
    ingressId: randomUUID(),
    id: messageId,
  };
}

function storedParticipantJson(
  seq: number,
  textLen: number,
): {
  readonly id: string;
  readonly seq: number;
  readonly actor: "participant";
  readonly text: string;
  readonly providerMessageId: null;
  readonly ingressId: string;
  readonly outboxId: null;
  readonly attention: null;
  readonly at: string;
} {
  return {
    id: `00000000-0000-4000-8000-${seq.toString(16).padStart(12, "0")}`,
    seq,
    actor: "participant",
    text: "x".repeat(textLen),
    providerMessageId: null,
    ingressId: `00000000-0000-4000-8001-${seq.toString(16).padStart(12, "0")}`,
    outboxId: null,
    attention: null,
    at: repliedAt.toISOString(),
  };
}

function largestTextLenWithJsonUnderLimit(count: number): number {
  let lo = 1;
  let hi = 64_000;
  let best = 1;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const bytes = Buffer.byteLength(
      JSON.stringify(
        Array.from({ length: count }, (_, index) =>
          storedParticipantJson(index + 1, mid),
        ),
      ),
      "utf8",
    );
    if (bytes <= FEEDBACK_CONVERSATION_MAX_MESSAGES_BYTES) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

function withFullMessageAttention(
  messages: ReturnType<typeof storedParticipantJson>[],
) {
  return messages.map((message, index) =>
    index === 0
      ? {
          ...message,
          attention: {
            categories: POST_EVENT_FEEDBACK_SAFETY_CATEGORIES,
            recommendedAction: "urgent_human_follow_up" as const,
            confidence: 0.99,
          },
        }
      : message,
  );
}

async function pgColumnSize(
  transaction: AppTransaction,
  messages: unknown,
): Promise<number> {
  const jsonText = JSON.stringify(messages);
  const measured = await transaction.execute<{ size: number }>(
    sql`select pg_column_size(cast(${jsonText} as jsonb))::int as size`,
  );
  const row = measured.rows[0];
  if (row === undefined) {
    throw new Error("pg_column_size returned no row");
  }
  return Number(row.size);
}

async function largestTextLenWithPgUnderLimit(
  transaction: AppTransaction,
  count: number,
): Promise<number> {
  const jsonMax = largestTextLenWithJsonUnderLimit(count);
  let lo = Math.max(1, jsonMax - 256);
  let hi = jsonMax;
  let best = lo;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const stored = Array.from({ length: count }, (_, index) =>
      storedParticipantJson(index + 1, mid),
    );
    const size = await pgColumnSize(transaction, stored);
    if (size <= FEEDBACK_CONVERSATION_MAX_MESSAGES_BYTES) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}
