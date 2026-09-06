import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  createDatabase,
  type AppTransaction,
  type DatabaseClient,
} from "@slopform/database";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { DatabaseService } from "../../../infrastructure/database/database.service.js";
import type { FeedbackCampaignRepository } from "../campaign/campaign.repository.js";
import { feedbackConversationFixture } from "../post-event-feedback-doubles.harness.js";
import {
  createFeedbackClosingDedupeKey,
  createFeedbackExtractionParkedNoticeDedupeKey,
  createFeedbackFallbackAckDedupeKey,
  createFeedbackFallbackDedupeKey,
} from "../extraction/extraction.schemas.js";
import {
  createFeedbackIntroDedupeKey,
  createFeedbackMediaNoticeDedupeKey,
  createFeedbackReminderDedupeKey,
  createFeedbackStopAckDedupeKey,
} from "../question-set.js";
import {
  evaluateDispatchContext,
  type OrdinaryDispatchEvidence,
} from "./dispatch-context.js";
import { FeedbackOutboundIntentService } from "./outbound-intent.service.js";
import { FeedbackOutboundLogRepository } from "./outbound-log.repository.js";
import { FeedbackOutboundLogService } from "./outbound-log.service.js";
import { FeedbackOutboxRepository } from "./outbox.repository.js";

const postgresTestUrl = process.env.FEEDBACK_POSTGRES_TEST_URL;
const describePostgres = postgresTestUrl ? describe : describe.skip;
const migrationsFolder = fileURLToPath(
  new URL("../../../../../../packages/database/drizzle", import.meta.url),
);
const upgradeSql = readFileSync(
  `${migrationsFolder}/20260906135130_message_outbox_dispatch_context.sql`,
  "utf8",
);
const conversationId = "11111111-1111-4111-8111-111111111111";
const campaignId = "22222222-2222-4222-8222-222222222222";
const ingressId = "33333333-3333-4333-8333-333333333333";
const originalSnapshot = {
  latestMessageSeq: 3,
  control: {
    mode: "bot",
    source: "launch",
    changedAt: "2026-09-05T12:00:00.000Z",
  },
  work: { revision: 7, executionEpoch: 4, campaignResumeGeneration: 2 },
  participantIngressIds: [ingressId],
} satisfies OrdinaryDispatchEvidence;

type UpgradedOutbox = {
  id: string;
  conversation_id: string;
  kind: string;
  dedupe_key: string;
  status: string;
  dispatch_context: unknown;
  last_error: string | null;
  send_started_at: Date | null;
  attempt_count: number;
};

describePostgres("Feedback dispatch-context PostgreSQL contract", () => {
  let client: DatabaseClient;

  beforeAll(async () => {
    if (!postgresTestUrl) return;
    client = createDatabase({
      connectionString: postgresTestUrl,
      applicationName: "feedback-dispatch-upgrade-test",
      maxConnections: 1,
    });
    await migrate(client.db, { migrationsFolder });
  });

  afterAll(async () => client?.pool.end());

  it("copies original evidence and keeps history unchanged", async () => {
    await withLegacyTables(async (tx) => {
      const id = await seedReply(tx, 3, { snapshot: originalSnapshot });
      await tx.execute(sql.raw(upgradeSql));
      const row = await readOutbox(tx, id);
      expect(row.dispatch_context).toEqual({
        schemaVersion: 1,
        purpose: "extraction_reply",
        evidence: originalSnapshot,
      });
      expect(authority(row).state).toBe("usable");
      expect(row.status).toBe("pending");
      const history = await tx.execute(sql`
        SELECT conversation_state FROM message_outbox_log WHERE outbox_id = ${id}
      `);
      expect(history.rows[0]?.conversation_state).toEqual(originalSnapshot);
    });
  });

  it("does not manufacture authority from incomplete or inconsistent history", async () => {
    await withLegacyTables(async (tx) => {
      const withoutIngress = {
        ...originalSnapshot,
        participantIngressIds: undefined,
      };
      const ids = [
        await seedReply(tx, 1, { snapshot: withoutIngress }),
        await seedReply(tx, 2, { decision: { origin: "extraction_reply" } }),
        await seedReply(tx, 3, {
          decision: { origin: "campaign_intro", closingReason: null },
        }),
        await seedReply(tx, 4, { logConversationId: randomUUID() }),
        await seedReply(tx, 5, { logCampaignId: randomUUID() }),
        await seedReply(tx, 6, {
          snapshot: { ...originalSnapshot, work: null },
        }),
      ];
      await tx.execute(sql.raw(upgradeSql));
      for (const id of ids) {
        expect.soft(authority(await readOutbox(tx, id)).state).toBe("reject");
      }
    });
  });

  it.each([
    [
      "campaign_intro",
      "intro",
      createFeedbackIntroDedupeKey(conversationId),
      {},
    ],
    [
      "reminder",
      "reminder",
      createFeedbackReminderDedupeKey(conversationId, 2),
      { rung: 2 },
    ],
    [
      "staff_message",
      "staff",
      `feedback-staff-${conversationId}-request-1`,
      { staffActorId: "staff-1" },
    ],
    [
      "stop_ack",
      "system",
      createFeedbackStopAckDedupeKey(conversationId),
      { sourceIngressId: ingressId },
    ],
    [
      "media_notice",
      "system",
      createFeedbackMediaNoticeDedupeKey(conversationId),
      { sourceIngressId: ingressId },
    ],
    [
      "extraction_parked_notice",
      "system",
      createFeedbackExtractionParkedNoticeDedupeKey(conversationId),
      {},
    ],
    [
      "extraction_fallback_ack",
      "system",
      createFeedbackFallbackAckDedupeKey(conversationId),
      {},
    ],
    [
      "extraction_fallback_fence",
      "system",
      createFeedbackFallbackDedupeKey(conversationId, 2),
      {},
    ],
    [
      "extraction_closing",
      "reply",
      createFeedbackClosingDedupeKey(conversationId, 3, 7),
      { closingReason: "completed" },
    ],
  ] as const)(
    "recognizes the historical %s purpose",
    async (purpose, kind, dedupeKey, detail) => {
      await withLegacyTables(async (tx) => {
        const origin =
          purpose === "extraction_closing" ? "extraction_reply" : purpose;
        const id = await seedReply(tx, 3, {
          origin,
          kind,
          dedupeKey,
          decision: { origin, ...detail },
        });
        await tx.execute(sql.raw(upgradeSql));
        const row = await readOutbox(tx, id);
        expect(row.dispatch_context).toMatchObject({
          schemaVersion: 1,
          purpose,
        });
        expect(authority(row).state).toBe(
          purpose === "extraction_fallback_fence" ? "reject" : "usable",
        );
      });
    },
  );

  it("cancels only safely pre-send unusable rows and preserves uncertain delivery", async () => {
    await withLegacyTables(async (tx) => {
      const statuses = [
        "pending",
        "held",
        "claimed",
        "attempting",
        "sending",
        "ambiguous",
        "sent",
      ] as const;
      const fixtures = [];
      for (const status of statuses) {
        const id = randomUUID();
        const attempted = status === "attempting" || status === "ambiguous";
        const claimed = attempted || status === "claimed";
        await tx.execute(sql`
          INSERT INTO message_outbox
            (id, conversation_id, campaign_id, kind, body, dedupe_key, status,
             claim_token, claim_expires_at, send_started_at, attempt_count)
          VALUES (${id}, ${conversationId}, ${campaignId}, 'reply', 'test', ${id}, ${status},
            ${claimed ? randomUUID() : null},
            ${status === "claimed" || status === "attempting" ? new Date() : null},
            ${attempted ? new Date("2026-09-05T12:00:00Z") : null},
            ${attempted ? 1 : 0})
        `);
        fixtures.push({ id, status, attempted });
      }
      await tx.execute(sql.raw(upgradeSql));
      for (const fixture of fixtures) {
        const row = await readOutbox(tx, fixture.id);
        const cancellable = ["pending", "held", "claimed"].includes(
          fixture.status,
        );
        expect(row.status).toBe(cancellable ? "cancelled" : fixture.status);
        expect(row.last_error).toBe(
          cancellable ? "dispatch_context_unusable" : null,
        );
        expect(row.attempt_count).toBe(fixture.attempted ? 1 : 0);
        expect(row.send_started_at !== null).toBe(fixture.attempted);
        expect(authority(row)).toMatchObject({
          state: "reject",
          reason: "dispatch_context_unusable",
        });
      }
    });
  });

  it("cannot revive or replace an unusable legacy intent through dedupe replay", async () => {
    await withLegacyTables(async (tx) => {
      const id = await seedReply(tx, 3, { decision: {} });
      await tx.execute(sql.raw(upgradeSql));
      const legacy = await readOutbox(tx, id);
      const replay = await intentService().enqueue(tx, {
        dispatch: {
          schemaVersion: 1,
          purpose: "extraction_reply",
          evidence: originalSnapshot,
        },
        message: {
          conversationId,
          campaignId,
          body: "replacement",
          dedupeKey: legacy.dedupe_key,
        },
        history: {
          conversation: feedbackConversationFixture({
            _id: conversationId,
            campaignId,
          }),
          decision: {
            origin: "extraction_reply",
            model: "test",
            confidence: null,
            closingReason: null,
            askedGoal: null,
            goalStatuses: [],
          },
          correlationId: "replay",
        },
      });
      expect(replay.inserted).toBe(false);
      expect(replay.row).toMatchObject({
        id,
        status: "cancelled",
        body: "test",
        dispatchContext: { schemaVersion: 1, purpose: "unusable_legacy" },
      });
      const history = await tx.execute(
        sql`SELECT decision FROM message_outbox_log WHERE outbox_id = ${id}`,
      );
      expect(history.rows).toEqual([{ decision: {} }]);
    });
  });

  it("rolls back the new intent and its context when historical recording fails", async () => {
    await withLegacyTables(async (tx) => {
      await tx.execute(sql.raw(upgradeSql));
      await expect(
        tx.transaction((nested) =>
          intentService().enqueue(nested, {
            dispatch: { schemaVersion: 1, purpose: "campaign_intro" },
            message: {
              conversationId,
              campaignId,
              body: "hello",
              dedupeKey: createFeedbackIntroDedupeKey(conversationId),
            },
            history: {
              conversation: feedbackConversationFixture({
                _id: conversationId,
                campaignId,
              }),
              decision: { origin: "campaign_intro", conversationCreated: true },
              correlationId: "",
            },
          }),
        ),
      ).rejects.toMatchObject({
        cause: { constraint: "message_outbox_log_correlation_id_length_check" },
      });
      expect(
        (await tx.execute(sql`SELECT id FROM message_outbox`)).rows,
      ).toEqual([]);
      expect(
        (await tx.execute(sql`SELECT id FROM message_outbox_log`)).rows,
      ).toEqual([]);
    });
  });

  function intentService() {
    const database = { db: client.db } as DatabaseService;
    return new FeedbackOutboundIntentService(
      new FeedbackOutboxRepository(database, {} as FeedbackCampaignRepository),
      new FeedbackOutboundLogService(
        new FeedbackOutboundLogRepository(database),
      ),
    );
  }

  async function withLegacyTables(work: (tx: AppTransaction) => Promise<void>) {
    const rollback = new Error("rollback upgrade fixture");
    try {
      await client.db.transaction(async (tx) => {
        // Session-local copies retain the real checks. The upgrade changes only
        // these two tables; no application rows or migration journal are touched.
        await tx.execute(
          sql.raw(`
          SET LOCAL search_path = pg_temp, public;
          CREATE TEMP TABLE message_outbox
            (LIKE public.message_outbox INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES) ON COMMIT DROP;
          ALTER TABLE pg_temp.message_outbox DROP COLUMN dispatch_context;
          CREATE TEMP TABLE message_outbox_log
            (LIKE public.message_outbox_log INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES) ON COMMIT DROP;
        `),
        );
        await work(tx);
        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    }
  }
});

async function seedReply(
  tx: AppTransaction,
  seq: number,
  options: {
    snapshot?: unknown;
    decision?: unknown;
    logConversationId?: string;
    logCampaignId?: string;
    origin?: string;
    kind?: string;
    dedupeKey?: string;
  },
): Promise<string> {
  const id = randomUUID();
  await tx.execute(sql`
    INSERT INTO message_outbox (id, conversation_id, campaign_id, kind, body, dedupe_key)
    VALUES (${id}, ${conversationId}, ${campaignId}, ${options.kind ?? "reply"}, 'test',
      ${options.dedupeKey ?? `feedback-reply-${conversationId}-${seq}`})
  `);
  await tx.execute(sql`
    INSERT INTO message_outbox_log
      (outbox_id, conversation_id, campaign_id, origin, correlation_id, decision, conversation_state)
    VALUES (${id}, ${options.logConversationId ?? conversationId},
      ${options.logCampaignId ?? campaignId}, ${options.origin ?? "extraction_reply"}, 'upgrade-test',
      ${JSON.stringify(options.decision ?? { origin: "extraction_reply", closingReason: null })}::jsonb,
      ${JSON.stringify(options.snapshot ?? originalSnapshot)}::jsonb)
  `);
  return id;
}

async function readOutbox(
  tx: AppTransaction,
  id: string,
): Promise<UpgradedOutbox> {
  const result = await tx.execute<UpgradedOutbox>(sql`
    SELECT id, conversation_id, kind, dedupe_key, status, dispatch_context,
      last_error, send_started_at, attempt_count FROM message_outbox WHERE id = ${id}
  `);
  const row = result.rows[0];
  if (!row) throw new Error("Missing upgrade fixture");
  return row;
}

function authority(row: UpgradedOutbox) {
  return evaluateDispatchContext({
    context: row.dispatch_context,
    kind: row.kind,
    dedupeKey: row.dedupe_key,
    conversationId: row.conversation_id,
  });
}
