import { messageOutbox, type MessageOutboxRow } from "@slopform/database";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";

import type { DatabaseService } from "../../../infrastructure/database/database.service.js";
import type { FeedbackCampaignRepository } from "../campaign/campaign.repository.js";
import { FakeFeedbackRepository } from "../post-event-feedback-doubles.harness.js";
import {
  FEEDBACK_OUTBOX_DISPATCH_LEASE_MS,
  FEEDBACK_OUTBOX_FIFO_BLOCKING_STATUSES,
  FEEDBACK_OUTBOX_LEGACY_AMBIGUOUS_ERROR,
  FeedbackOutboxRepository,
} from "./outbox.repository.js";

const outboxId = "66de52a8-1a26-4cbb-b8d1-fcf8bdc2dd51";
const now = new Date("2026-08-03T12:00:00.000Z");

describe("FeedbackOutboxRepository direct dispatch", () => {
  it("lets an exact terminal id pass only ambiguous FIFO and campaign pause gates", async () => {
    const fake = new FakeFeedbackRepository(() => now);
    fake.campaigns.set("3f2504e0-4f89-41d3-9a0c-0305e82c3301", {
      id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
      eventId: "5c2f0b8e-9b1a-4a41-8f27-1a6f9b0c2d10",
      status: "paused",
      questionSetVersion: 2,
      questions: {},
    });
    fake.seedOutbox({
      id: "14b0d0f3-8cf0-4420-ae96-8eb77a21915e",
      conversationId: "7c57f3b8-2b13-48f5-8730-18ac71f490cd",
      campaignId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
      body: "old",
      dedupeKey: "old",
      status: "ambiguous",
      createdAt: new Date("2026-08-03T11:00:00.000Z"),
    });
    fake.seedOutbox({
      id: outboxId,
      conversationId: "7c57f3b8-2b13-48f5-8730-18ac71f490cd",
      campaignId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
      kind: "system",
      body: "stopped",
      dedupeKey: "feedback-stop-ack-7c57f3b8-2b13-48f5-8730-18ac71f490cd",
      status: "pending",
      createdAt: new Date("2026-08-03T11:01:00.000Z"),
    });

    await expect(fake.listTerminalDispatchCandidates()).resolves.toEqual([
      {
        conversationId: "7c57f3b8-2b13-48f5-8730-18ac71f490cd",
        outboxId,
      },
    ]);
    await expect(fake.claimDispatchBatch(now)).resolves.toEqual([]);
    await expect(
      fake.claimDispatchBatch(now, 4, FEEDBACK_OUTBOX_DISPATCH_LEASE_MS, [
        outboxId,
      ]),
    ).resolves.toEqual([
      expect.objectContaining({ id: outboxId, status: "claimed" }),
    ]);
  });

  it("never lets an exact terminal id pass an older live attempt", async () => {
    const fake = new FakeFeedbackRepository(() => now);
    fake.campaigns.set("3f2504e0-4f89-41d3-9a0c-0305e82c3301", {
      id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
      eventId: "5c2f0b8e-9b1a-4a41-8f27-1a6f9b0c2d10",
      status: "launched",
      questionSetVersion: 2,
      questions: {},
    });
    fake.seedOutbox({
      id: "14b0d0f3-8cf0-4420-ae96-8eb77a21915e",
      conversationId: "7c57f3b8-2b13-48f5-8730-18ac71f490cd",
      campaignId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
      body: "old",
      dedupeKey: "old",
      status: "attempting",
      sendStartedAt: new Date("2026-08-03T11:00:00.000Z"),
      createdAt: new Date("2026-08-03T11:00:00.000Z"),
    });
    fake.seedOutbox({
      id: outboxId,
      conversationId: "7c57f3b8-2b13-48f5-8730-18ac71f490cd",
      campaignId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
      kind: "system",
      body: "stopped",
      dedupeKey: "feedback-stop-ack-7c57f3b8-2b13-48f5-8730-18ac71f490cd",
      status: "pending",
      createdAt: new Date("2026-08-03T11:01:00.000Z"),
    });

    await expect(fake.listTerminalDispatchCandidates()).resolves.toEqual([]);
    await expect(
      fake.claimDispatchBatch(now, 4, FEEDBACK_OUTBOX_DISPATCH_LEASE_MS, [
        outboxId,
      ]),
    ).resolves.toEqual([]);
  });

  it("uses the same conversation advisory-lock namespace as extraction", async () => {
    const execute = vi.fn().mockResolvedValue(undefined);
    const database = {
      db: {},
      transaction: vi.fn(),
    } as unknown as DatabaseService;
    const repository = new FeedbackOutboxRepository(
      database,
      {} as FeedbackCampaignRepository,
    );

    await repository.lockConversation(
      { execute } as never,
      "7c57f3b8-2b13-48f5-8730-18ac71f490cd",
    );

    const [statement] = execute.mock.calls[0] as [SQL];
    const query = new PgDialect().sqlToQuery(statement);
    expect(query.sql).toContain("pg_advisory_xact_lock(hashtextextended(");
    expect(query.params).toEqual([
      "feedback-conversation:7c57f3b8-2b13-48f5-8730-18ac71f490cd",
    ]);
  });

  it("claims a bounded batch with PostgreSQL SKIP LOCKED and a durable token", async () => {
    const pending = outboxRow();
    let claimedValues: Record<string, unknown> = {};

    const returning = vi.fn().mockImplementation(async () => [
      {
        ...pending,
        ...claimedValues,
        claimExpiresAt: new Date("2026-08-03T12:02:00.000Z"),
      },
    ]);
    const updateWhere = vi.fn().mockReturnValue({ returning });
    const set = vi
      .fn()
      .mockImplementation((values: Record<string, unknown>) => {
        claimedValues = values;
        return { where: updateWhere };
      });
    const update = vi.fn().mockReturnValue({ set });

    const forUpdate = vi.fn().mockResolvedValue([{ row: pending }]);
    const limit = vi.fn().mockReturnValue({ for: forUpdate });
    const orderBy = vi.fn().mockReturnValue({ limit });
    const selectWhere = vi.fn().mockReturnValue({ orderBy });
    const innerJoin = vi.fn().mockReturnValue({ where: selectWhere });
    const from = vi.fn().mockReturnValue({ innerJoin });
    const sqlBuilder = drizzle.mock();
    const select = vi
      .fn()
      .mockImplementation((fields: object) =>
        "row" in fields ? { from } : sqlBuilder.select(fields as never),
      );
    const database = {
      transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) =>
        work({ select, update }),
      ),
      db: {},
    } as unknown as DatabaseService;
    const campaigns = { findCampaignById: vi.fn() };
    const repository = new FeedbackOutboxRepository(
      database,
      campaigns as unknown as FeedbackCampaignRepository,
    );

    const claimed = await repository.claimDispatchBatch(
      now,
      10,
      FEEDBACK_OUTBOX_DISPATCH_LEASE_MS,
      [outboxId],
    );

    expect(forUpdate).toHaveBeenCalledWith("update", {
      of: messageOutbox,
      skipLocked: true,
    });
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "claimed",
        claimToken: expect.stringMatching(/^[0-9a-f-]{36}$/u),
        sendStartedAt: null,
      }),
    );
    const [claimedSet] = set.mock.calls[0] as [Record<string, unknown>];
    const leaseQuery = new PgDialect().sqlToQuery(
      claimedSet.claimExpiresAt as SQL,
    );
    expect(leaseQuery.sql).toContain("clock_timestamp()");
    expect(leaseQuery.params).toEqual([FEEDBACK_OUTBOX_DISPATCH_LEASE_MS]);
    const [eligibility] = selectWhere.mock.calls[0] as [SQL];
    const eligibilityQuery = new PgDialect().sqlToQuery(eligibility);
    expect(eligibilityQuery.sql).toContain("not exists");
    expect(eligibilityQuery.sql).toContain('"older_message_outbox"');
    expect(eligibilityQuery.sql).toContain(
      '"older_message_outbox"."conversation_id" = "message_outbox"."conversation_id"',
    );
    expect(eligibilityQuery.sql).toContain(
      '"older_message_outbox"."created_at" < "message_outbox"."created_at"',
    );
    expect(eligibilityQuery.sql).toContain(
      '"older_message_outbox"."id" < "message_outbox"."id"',
    );
    expect(eligibilityQuery.sql).toContain('"message_outbox"."kind" <>');
    expect(eligibilityQuery.sql).toContain(
      '"older_message_outbox"."status" <>',
    );
    expect(eligibilityQuery.sql).toContain('"message_outbox"."id" not in');
    expect(eligibilityQuery.sql).toContain(
      '"feedback_campaigns"."status" = $1 or "message_outbox"."id" in',
    );
    expect(eligibilityQuery.params).toEqual(
      expect.arrayContaining([...FEEDBACK_OUTBOX_FIFO_BLOCKING_STATUSES]),
    );
    expect(eligibilityQuery.params).not.toContain(now);
    expect(eligibilityQuery.params).toContain(outboxId);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({
      id: outboxId,
      status: "claimed",
      sendStartedAt: null,
    });
    // Campaign status is part of the claim SQL, not an N+1 query per row.
    expect(campaigns.findCampaignById).not.toHaveBeenCalled();
  });

  it("does not report a terminal write when the token CAS matched no row", async () => {
    const returning = vi.fn().mockResolvedValue([]);
    const where = vi.fn().mockReturnValue({ returning });
    const set = vi.fn().mockReturnValue({ where });
    const update = vi.fn().mockReturnValue({ set });
    const database = {
      db: { update },
      transaction: vi.fn(),
    } as unknown as DatabaseService;
    const repository = new FeedbackOutboxRepository(
      database,
      {} as FeedbackCampaignRepository,
    );

    await expect(
      repository.markDispatchSent(outboxId, "stale-token", {
        completedAt: now,
        providerLogId: "42",
        deliveryStatus: "sent",
        sentAt: now,
      }),
    ).resolves.toBeUndefined();
    expect(where).toHaveBeenCalledTimes(1);
  });

  it.each(["pending", "held", "claimed"] as const)(
    "cancels a pre-provider fixed V1 closing row in status %s before anchored admission",
    async (status) => {
      const legacy = outboxRow({
        status,
        dedupeKey: "feedback-closing-7c57f3b8-2b13-48f5-8730-18ac71f490cd",
        ...(status === "claimed"
          ? {
              claimToken: "118234ec-14f8-4c2a-90f3-330a092e4f60",
              claimExpiresAt: new Date("2026-08-03T12:02:00.000Z"),
            }
          : {}),
      });
      const forUpdate = vi.fn().mockResolvedValue([legacy]);
      const limit = vi.fn().mockReturnValue({ for: forUpdate });
      const selectWhere = vi.fn().mockReturnValue({ limit });
      const from = vi.fn().mockReturnValue({ where: selectWhere });
      const updateWhere = vi.fn().mockResolvedValue([]);
      const set = vi.fn().mockReturnValue({ where: updateWhere });
      const transaction = {
        select: vi.fn().mockReturnValue({ from }),
        update: vi.fn().mockReturnValue({ set }),
      };
      const repository = new FeedbackOutboxRepository(
        { db: {}, transaction: vi.fn() } as unknown as DatabaseService,
        {} as FeedbackCampaignRepository,
      );

      await expect(
        repository.resolveLegacyClosingBeforeAnchoredInsert(
          transaction as never,
          legacy.dedupeKey,
        ),
      ).resolves.toEqual({ outcome: "clear" });

      expect(forUpdate).toHaveBeenCalledWith("update");
      expect(set).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "cancelled",
          claimExpiresAt: null,
          lastError: "superseded_by_anchored_closing",
        }),
      );
    },
  );

  it.each(["attempting", "ambiguous", "sending", "sent"] as const)(
    "suppresses an anchored close behind provider-crossed V1 status %s",
    async (status) => {
      const legacy = outboxRow({
        status,
        dedupeKey: "feedback-closing-7c57f3b8-2b13-48f5-8730-18ac71f490cd",
        ...(status === "attempting"
          ? {
              claimToken: "118234ec-14f8-4c2a-90f3-330a092e4f60",
              claimExpiresAt: new Date("2026-08-03T12:02:00.000Z"),
              sendStartedAt: now,
            }
          : {}),
      });
      const forUpdate = vi.fn().mockResolvedValue([legacy]);
      const limit = vi.fn().mockReturnValue({ for: forUpdate });
      const selectWhere = vi.fn().mockReturnValue({ limit });
      const from = vi.fn().mockReturnValue({ where: selectWhere });
      const transaction = {
        select: vi.fn().mockReturnValue({ from }),
        update: vi.fn(),
      };
      const repository = new FeedbackOutboxRepository(
        { db: {}, transaction: vi.fn() } as unknown as DatabaseService,
        {} as FeedbackCampaignRepository,
      );

      await expect(
        repository.resolveLegacyClosingBeforeAnchoredInsert(
          transaction as never,
          legacy.dedupeKey,
        ),
      ).resolves.toEqual({ outcome: "provider_crossed", row: legacy });
      expect(transaction.update).not.toHaveBeenCalled();
    },
  );

  it("renews the exact pre-send token even after its old pacing lease elapsed", async () => {
    const renewed = outboxRow({
      status: "claimed",
      claimToken: "118234ec-14f8-4c2a-90f3-330a092e4f60",
      claimExpiresAt: new Date("2026-08-03T11:59:00.000Z"),
    });
    const returning = vi.fn().mockResolvedValue([renewed]);
    const where = vi.fn().mockReturnValue({ returning });
    const set = vi.fn().mockReturnValue({ where });
    const update = vi.fn().mockReturnValue({ set });
    const database = {
      db: { update },
      transaction: vi.fn(),
    } as unknown as DatabaseService;
    const repository = new FeedbackOutboxRepository(
      database,
      {} as FeedbackCampaignRepository,
    );

    const skewedApplicationClock = new Date("2040-01-01T00:00:00.000Z");
    await expect(
      repository.renewDispatchClaim(
        outboxId,
        "118234ec-14f8-4c2a-90f3-330a092e4f60",
        skewedApplicationClock,
        90_000,
      ),
    ).resolves.toEqual(renewed);
    const [renewalSet] = set.mock.calls[0] as [Record<string, unknown>];
    const renewalQuery = new PgDialect().sqlToQuery(
      renewalSet.claimExpiresAt as SQL,
    );
    expect(renewalQuery.sql).toContain("clock_timestamp()");
    expect(renewalQuery.params).toEqual([90_000]);
    const updatedAtQuery = new PgDialect().sqlToQuery(
      renewalSet.updatedAt as SQL,
    );
    expect(updatedAtQuery.sql).toBe("clock_timestamp()");
    const [predicate] = where.mock.calls[0] as [SQL];
    const query = new PgDialect().sqlToQuery(predicate);
    expect(query.sql).toContain('"message_outbox"."send_started_at" is null');
    expect(query.sql).not.toContain('"message_outbox"."claim_expires_at" >');
    expect(query.params).toEqual([
      outboxId,
      "claimed",
      "118234ec-14f8-4c2a-90f3-330a092e4f60",
    ]);
  });

  it("uses PostgreSQL time for the attempt marker and its live-lease fence", async () => {
    const attempting = outboxRow({
      status: "attempting",
      claimToken: "118234ec-14f8-4c2a-90f3-330a092e4f60",
      claimExpiresAt: new Date("2026-08-03T12:02:00.000Z"),
      sendStartedAt: now,
      attemptCount: 1,
    });
    const returning = vi.fn().mockResolvedValue([attempting]);
    const where = vi.fn().mockReturnValue({ returning });
    const set = vi.fn().mockReturnValue({ where });
    const update = vi.fn().mockReturnValue({ set });
    const sqlBuilder = drizzle.mock();
    const database = {
      db: { update, select: sqlBuilder.select.bind(sqlBuilder) },
      transaction: vi.fn(),
    } as unknown as DatabaseService;
    const repository = new FeedbackOutboxRepository(
      database,
      {} as FeedbackCampaignRepository,
    );

    await expect(
      repository.markDispatchAttemptStarted(
        outboxId,
        "118234ec-14f8-4c2a-90f3-330a092e4f60",
        new Date("2040-01-01T00:00:00.000Z"),
        45_000,
      ),
    ).resolves.toEqual(attempting);

    const [attemptSet] = set.mock.calls[0] as [Record<string, unknown>];
    expect(
      new PgDialect().sqlToQuery(attemptSet.sendStartedAt as SQL).sql,
    ).toBe("clock_timestamp()");
    const leaseQuery = new PgDialect().sqlToQuery(
      attemptSet.claimExpiresAt as SQL,
    );
    expect(leaseQuery.sql).toContain("clock_timestamp()");
    expect(leaseQuery.params).toEqual([45_000]);
    const [predicate] = where.mock.calls[0] as [SQL];
    const predicateQuery = new PgDialect().sqlToQuery(predicate);
    expect(predicateQuery.sql).toContain(
      '"message_outbox"."claim_expires_at" > clock_timestamp()',
    );
    expect(predicateQuery.sql).toContain("for share");
    expect(predicateQuery.params).not.toContain(
      new Date("2040-01-01T00:00:00.000Z"),
    );
  });

  it.each(["paused", "closed"] as const)(
    "keeps the exact lifecycle-authorized STOP marker eligible when the campaign is %s",
    async (_campaignStatus) => {
      const marker = createAttemptMarkerRepository();

      await expect(
        marker.repository.markDispatchAttemptStarted(
          outboxId,
          marker.claimToken,
          now,
          45_000,
          outboxId,
        ),
      ).resolves.toEqual(marker.attempting);

      const [predicate] = marker.where.mock.calls[0] as [SQL];
      const query = new PgDialect().sqlToQuery(predicate);
      expect(query.sql).toMatch(
        /"feedback_campaigns"\."status" = .* or "message_outbox"\."id" =/u,
      );
      // The exact id appears once in the row-token fence and once as the sole
      // non-launched campaign authority.
      expect(query.params.filter((value) => value === outboxId)).toHaveLength(
        2,
      );
    },
  );

  it("does not grant a dedupe-shaped impostor a non-launched campaign marker", async () => {
    const marker = createAttemptMarkerRepository();
    const otherTerminalOutboxId = "22b43614-8de9-48bd-a3e1-290427cfbbca";

    await marker.repository.markDispatchAttemptStarted(
      outboxId,
      marker.claimToken,
      now,
      45_000,
      otherTerminalOutboxId,
    );

    const [predicate] = marker.where.mock.calls[0] as [SQL];
    const query = new PgDialect().sqlToQuery(predicate);
    expect(query.sql).not.toMatch(
      /"feedback_campaigns"\."status" = .* or "message_outbox"\."id" =/u,
    );
    expect(query.params).not.toContain(otherTerminalOutboxId);
    expect(query.params.filter((value) => value === outboxId)).toHaveLength(1);
  });

  it("finds then token-fences an expired post-marker quarantine", async () => {
    const attempting = outboxRow({
      status: "attempting",
      claimToken: "118234ec-14f8-4c2a-90f3-330a092e4f60",
      claimExpiresAt: new Date("2026-08-03T11:59:00.000Z"),
      sendStartedAt: new Date("2026-08-03T11:58:00.000Z"),
      attemptCount: 1,
    });
    const selectLimit = vi.fn().mockResolvedValue([attempting]);
    const orderBy = vi.fn().mockReturnValue({ limit: selectLimit });
    const selectWhere = vi.fn().mockReturnValue({ orderBy });
    const from = vi.fn().mockReturnValue({ where: selectWhere });
    const select = vi.fn().mockReturnValue({ from });
    const returning = vi.fn().mockResolvedValue([attempting]);
    const updateWhere = vi.fn().mockReturnValue({ returning });
    const set = vi.fn().mockReturnValue({ where: updateWhere });
    const update = vi.fn().mockReturnValue({ set });
    const database = {
      db: { select, update },
      transaction: vi.fn(),
    } as unknown as DatabaseService;
    const repository = new FeedbackOutboxRepository(
      database,
      {} as FeedbackCampaignRepository,
    );

    await expect(repository.findExpiredDispatchAttempts(now)).resolves.toEqual([
      attempting,
    ]);
    await expect(
      repository.quarantineExpiredDispatchAttempt(
        outboxId,
        "118234ec-14f8-4c2a-90f3-330a092e4f60",
      ),
    ).resolves.toEqual(attempting);
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "ambiguous",
        claimExpiresAt: null,
        deliveryStatus: "pending",
        lastError: "dispatch_lease_expired_after_send_start",
      }),
    );
    const [selectionPredicate] = selectWhere.mock.calls[0] as [SQL];
    expect(new PgDialect().sqlToQuery(selectionPredicate).sql).toContain(
      "clock_timestamp()",
    );
    const [quarantinePredicate] = updateWhere.mock.calls[0] as [SQL];
    const quarantineQuery = new PgDialect().sqlToQuery(quarantinePredicate);
    expect(quarantineQuery.sql).toContain("clock_timestamp()");
    expect(quarantineQuery.params).toEqual([
      outboxId,
      "attempting",
      "118234ec-14f8-4c2a-90f3-330a092e4f60",
    ]);
  });

  it("quarantines stale legacy sending without inventing provider evidence", async () => {
    const sending = outboxRow({ status: "sending" });
    const selectLimit = vi.fn().mockResolvedValue([sending]);
    const orderBy = vi.fn().mockReturnValue({ limit: selectLimit });
    const selectWhere = vi.fn().mockReturnValue({ orderBy });
    const from = vi.fn().mockReturnValue({ where: selectWhere });
    const select = vi.fn().mockReturnValue({ from });
    const returning = vi.fn().mockResolvedValue([sending]);
    const updateWhere = vi.fn().mockReturnValue({ returning });
    const set = vi.fn().mockReturnValue({ where: updateWhere });
    const update = vi.fn().mockReturnValue({ set });
    const database = {
      db: { select, update },
      transaction: vi.fn(),
    } as unknown as DatabaseService;
    const repository = new FeedbackOutboxRepository(
      database,
      {} as FeedbackCampaignRepository,
    );

    await expect(repository.findStaleLegacySending(now)).resolves.toEqual([
      sending,
    ]);
    await expect(
      repository.quarantineStaleLegacySending(outboxId),
    ).resolves.toEqual(sending);
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "ambiguous",
        claimToken: null,
        claimExpiresAt: null,
        sendStartedAt: null,
        attemptCount: 0,
        lastError: FEEDBACK_OUTBOX_LEGACY_AMBIGUOUS_ERROR,
      }),
    );
  });
});

function outboxRow(
  overrides: Partial<MessageOutboxRow> = {},
): MessageOutboxRow {
  return {
    id: outboxId,
    conversationId: "7c57f3b8-2b13-48f5-8730-18ac71f490cd",
    campaignId: "89eccaa5-9ce6-4dcf-a630-5e35e4ec6f0d",
    kind: "reply",
    body: "Ευχαριστούμε!",
    status: "pending",
    dedupeKey: "conversation:1:cursor:3",
    createdByStaff: null,
    providerLogId: null,
    providerMessageId: null,
    deliveryStatus: null,
    sentAt: null,
    deliveredAt: null,
    readAt: null,
    playedAt: null,
    deliveryUpdatedAt: null,
    claimToken: null,
    claimExpiresAt: null,
    sendStartedAt: null,
    attemptCount: 0,
    lastError: null,
    createdAt: new Date("2026-07-25T00:00:00.000Z"),
    updatedAt: new Date("2026-07-25T00:00:00.000Z"),
    ...overrides,
  };
}

function createAttemptMarkerRepository() {
  const claimToken = "118234ec-14f8-4c2a-90f3-330a092e4f60";
  const attempting = outboxRow({
    status: "attempting",
    claimToken,
    claimExpiresAt: new Date("2026-08-03T12:02:00.000Z"),
    sendStartedAt: now,
    attemptCount: 1,
  });
  const returning = vi.fn().mockResolvedValue([attempting]);
  const where = vi.fn().mockReturnValue({ returning });
  const set = vi.fn().mockReturnValue({ where });
  const update = vi.fn().mockReturnValue({ set });
  const sqlBuilder = drizzle.mock();
  const database = {
    db: { update, select: sqlBuilder.select.bind(sqlBuilder) },
    transaction: vi.fn(),
  } as unknown as DatabaseService;
  return {
    attempting,
    claimToken,
    where,
    repository: new FeedbackOutboxRepository(
      database,
      {} as FeedbackCampaignRepository,
    ),
  };
}
