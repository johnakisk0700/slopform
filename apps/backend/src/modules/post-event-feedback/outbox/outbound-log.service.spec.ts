import { randomUUID } from "node:crypto";

import type { MessageOutboxRow } from "@slopform/database";
import { describe, expect, it } from "vitest";

import {
  FakeDatabase,
  FakeFeedbackRepository,
} from "../post-event-feedback-doubles.harness.js";
import {
  buildFeedbackConversationGoals,
  deriveFeedbackConversationId,
  feedbackConversationDocumentSchema,
  type FeedbackConversationDocument,
} from "../post-event-feedback-conversation.document.js";
import type { FeedbackOutboundLogRepository } from "./outbound-log.repository.js";
import type { FeedbackOutboundDecision } from "./outbound-log.schemas.js";
import { buildOutboundConversationSnapshot } from "./outbound-log.snapshot.js";
import { FeedbackOutboundLogService } from "./outbound-log.service.js";

const campaignId = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const respondentParticipantId = "9f3c1a52-6e2b-4b4a-9a17-2cb2a6d13a55";
const createdAt = new Date("2026-07-25T10:00:00.000Z");
const now = new Date("2026-07-25T10:30:00.000Z");

describe("FeedbackOutboundLogService", () => {
  it("writes one log row for a freshly inserted outbox row", async () => {
    const { service, repository, database } = createService();
    const conversation = conversationDocument({
      reminderCount: 1,
      remindedAt: now,
    });
    const outbox = repository.seedOutbox({
      conversationId: conversation._id,
      campaignId,
      body: "Πώς σου φάνηκε η βραδιά;",
      dedupeKey: "intro:1",
      kind: "intro",
    });
    const decision: FeedbackOutboundDecision = {
      origin: "campaign_intro",
      conversationCreated: true,
    };

    await database.transaction(async (transaction) => {
      await service.record(transaction, {
        outbox: { row: outbox as MessageOutboxRow, inserted: true },
        conversation,
        decision,
        correlationId: "correlation-intro-1",
      });
    });

    expect(repository.outboxLogs).toHaveLength(1);
    const log = repository.outboxLogs[0];
    expect(log).toMatchObject({
      outboxId: outbox.id,
      conversationId: conversation._id,
      campaignId,
      origin: "campaign_intro",
      correlationId: "correlation-intro-1",
      decision,
      conversationState: buildOutboundConversationSnapshot(conversation),
    });
  });

  it("skips the write when the outbox insert was a dedupe replay", async () => {
    const { service, repository, database } = createService();
    const conversation = conversationDocument();
    const outbox = repository.seedOutbox({
      conversationId: conversation._id,
      campaignId,
      body: "already sent",
      dedupeKey: "reply:1",
    });

    await database.transaction(async (transaction) => {
      await service.record(transaction, {
        outbox: { row: outbox as MessageOutboxRow, inserted: false },
        conversation,
        decision: {
          origin: "extraction_reply",
          model: "test-model",
          confidence: 0.9,
          closingReason: null,
          askedGoal: "overall",
          goalStatuses: [{ key: "overall", status: "asked" }],
        },
        correlationId: "correlation-replay",
      });
    });

    expect(repository.outboxLogs).toHaveLength(0);
  });

  it("throws on an invalid decision and writes nothing", async () => {
    const { service, repository, database } = createService();
    const conversation = conversationDocument();
    const outbox = repository.seedOutbox({
      conversationId: conversation._id,
      campaignId,
      body: "stop ack",
      dedupeKey: "stop:1",
      kind: "system",
    });

    await expect(
      database.transaction(async (transaction) => {
        await service.record(transaction, {
          outbox: { row: outbox as MessageOutboxRow, inserted: true },
          conversation,
          decision: {
            origin: "stop_ack",
            // Wrong shape for this origin — staffActorId belongs to staff_message.
            staffActorId: "admin-1",
          } as unknown as FeedbackOutboundDecision,
          correlationId: "correlation-invalid",
        });
      }),
    ).rejects.toThrow();

    expect(repository.outboxLogs).toHaveLength(0);
  });

  it("returns the existing log on outboxId conflict without duplicating", async () => {
    const { repository, database } = createService();
    const conversation = conversationDocument();
    const outboxId = randomUUID();
    const decision: FeedbackOutboundDecision = {
      origin: "reminder",
      rung: 2,
    };
    const conversationState = buildOutboundConversationSnapshot(conversation);
    const input = {
      outboxId,
      conversationId: conversation._id,
      campaignId,
      origin: decision.origin,
      correlationId: "correlation-reminder-2",
      decision,
      conversationState,
    };

    const first = await database.transaction(async (transaction) =>
      repository.insertOutboxLogIfAbsent(transaction, input),
    );
    const second = await database.transaction(async (transaction) =>
      repository.insertOutboxLogIfAbsent(transaction, {
        ...input,
        correlationId: "correlation-reminder-2-replay",
        decision: { origin: "reminder", rung: 99 },
      }),
    );

    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(second.row.id).toBe(first.row.id);
    expect(second.row.correlationId).toBe("correlation-reminder-2");
    expect(second.row.decision).toEqual(decision);
    expect(repository.outboxLogs).toHaveLength(1);
  });
});

function createService(): {
  service: FeedbackOutboundLogService;
  repository: FakeFeedbackRepository;
  database: FakeDatabase;
} {
  const repository = new FakeFeedbackRepository(() => now);
  const database = new FakeDatabase();
  const service = new FeedbackOutboundLogService(
    repository as unknown as FeedbackOutboundLogRepository,
  );
  return { service, repository, database };
}

function conversationDocument(
  overrides: Partial<FeedbackConversationDocument> = {},
): FeedbackConversationDocument {
  return feedbackConversationDocumentSchema.parse({
    _id: deriveFeedbackConversationId(campaignId, respondentParticipantId),
    schemaVersion: 2,
    purpose: "post_event_feedback",
    channel: "whatsapp",
    campaignId,
    respondentParticipantId,
    phoneAtLaunch: "+306900000000",
    lifecycle: { state: "open", reason: null, closedAt: null },
    control: { mode: "bot", source: "launch", changedAt: createdAt },
    goals: buildFeedbackConversationGoals(),
    messages: [],
    extraction: {
      cursorSeq: 0,
      lastRunAt: null,
      model: null,
      usage: null,
      serviceTier: null,
      parkedSince: null,
      parkedRuns: 0,
      parkedNoticeSentAt: null,
    },
    needsAttention: false,
    attentionReasons: [],
    remindedAt: null,
    reminderCount: 0,
    awaitingHuman: false,
    hostileTurns: 0,
    extractionFallbackAckSent: false,
    staffClose: null,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  });
}
