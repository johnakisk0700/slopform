import { describe, expect, it, vi } from "vitest";

import { messageOutbox } from "@join-the-six/database";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import type { DatabaseService } from "../../infrastructure/database/database.service.js";
import { FeedbackCampaignRepository } from "./campaign/campaign.repository.js";
import { FeedbackOutboxRepository } from "./outbox/outbox.repository.js";

describe("FeedbackOutboxRepository cancelQueuedOutboxForConversation", () => {
  it("cancels pending, held and token-owned claimed rows before send start", async () => {
    const returning = vi
      .fn()
      .mockResolvedValue([
        { id: "11111111-1111-4111-8111-111111111111" },
        { id: "22222222-2222-4222-8222-222222222222" },
      ]);
    const where = vi.fn().mockReturnValue({ returning });
    const set = vi.fn().mockReturnValue({ where });
    const update = vi.fn().mockReturnValue({ set });
    const database = {
      db: {},
      transaction: vi.fn(),
    } as unknown as DatabaseService;
    const repository = new FeedbackOutboxRepository(
      database,
      new FeedbackCampaignRepository(database),
    );

    const cancelled = await repository.cancelQueuedOutboxForConversation(
      { update } as never,
      "33333333-3333-4333-8333-333333333333",
    );

    expect(cancelled).toBe(2);
    expect(update).toHaveBeenCalledWith(messageOutbox);
    expect(set).toHaveBeenCalledWith({
      status: "cancelled",
      claimExpiresAt: null,
      updatedAt: expect.any(Date),
    });
    const [predicate] = where.mock.calls[0] as [SQL];
    const query = new PgDialect().sqlToQuery(predicate);
    expect(query.sql).toContain('"message_outbox"."send_started_at" is null');
    expect(query.params).toEqual([
      "33333333-3333-4333-8333-333333333333",
      "pending",
      "held",
      "claimed",
    ]);
  });

  it("preserves staff rows when takeover cancels automated pre-send work", async () => {
    const returning = vi.fn().mockResolvedValue([{ id: "automated" }]);
    const where = vi.fn().mockReturnValue({ returning });
    const set = vi.fn().mockReturnValue({ where });
    const update = vi.fn().mockReturnValue({ set });
    const database = {
      db: {},
      transaction: vi.fn(),
    } as unknown as DatabaseService;
    const repository = new FeedbackOutboxRepository(
      database,
      new FeedbackCampaignRepository(database),
    );
    const terminalOutboxId = "44444444-4444-4444-8444-444444444444";

    await expect(
      repository.cancelQueuedAutomatedOutboxForConversation(
        { update } as never,
        "33333333-3333-4333-8333-333333333333",
        terminalOutboxId,
      ),
    ).resolves.toBe(1);

    expect(set).toHaveBeenCalledWith({
      status: "cancelled",
      claimExpiresAt: null,
      updatedAt: expect.any(Date),
    });
    const [predicate] = where.mock.calls[0] as [SQL];
    const query = new PgDialect().sqlToQuery(predicate);
    expect(query.sql).toContain('"message_outbox"."kind" <> \'staff\'');
    expect(query.sql).toContain('"message_outbox"."id" <>');
    expect(query.sql).toContain('"message_outbox"."send_started_at" is null');
    expect(query.params).toEqual([
      "33333333-3333-4333-8333-333333333333",
      terminalOutboxId,
      "pending",
      "held",
      "claimed",
    ]);
  });

  it("retracts ordinary automation while preserving exact commitments and system/staff rows", async () => {
    const returning = vi.fn().mockResolvedValue([{ id: "ordinary" }]);
    const where = vi.fn().mockReturnValue({ returning });
    const set = vi.fn().mockReturnValue({ where });
    const update = vi.fn().mockReturnValue({ set });
    const database = {
      db: {},
      transaction: vi.fn(),
    } as unknown as DatabaseService;
    const repository = new FeedbackOutboxRepository(
      database,
      new FeedbackCampaignRepository(database),
    );
    const conversationId = "33333333-3333-4333-8333-333333333333";
    const handoffId = "44444444-4444-4444-8444-444444444444";
    const terminalId = "55555555-5555-4555-8555-555555555555";

    await expect(
      repository.cancelQueuedSupersededAutomationForConversation(
        { update } as never,
        conversationId,
        [handoffId, terminalId],
      ),
    ).resolves.toBe(1);

    expect(set).toHaveBeenCalledWith({
      status: "cancelled",
      claimExpiresAt: null,
      lastError: "superseded_by_newer_testimony",
      updatedAt: expect.any(Date),
    });
    const [predicate] = where.mock.calls[0] as [SQL];
    const query = new PgDialect().sqlToQuery(predicate);
    expect(query.sql).toContain('"message_outbox"."kind" not in');
    expect(query.sql).toContain('"message_outbox"."id" not in');
    expect(query.sql).toContain('"message_outbox"."send_started_at" is null');
    expect(query.params).toEqual([
      conversationId,
      "system",
      "staff",
      handoffId,
      terminalId,
      "pending",
      "held",
      "claimed",
    ]);
  });

  it("preserves exact STOP acknowledgements when campaign close retracts its queue", async () => {
    const returning = vi.fn().mockResolvedValue([{ id: "older" }]);
    const where = vi.fn().mockReturnValue({ returning });
    const set = vi.fn().mockReturnValue({ where });
    const update = vi.fn().mockReturnValue({ set });
    const database = {
      db: {},
      transaction: vi.fn(),
    } as unknown as DatabaseService;
    const repository = new FeedbackOutboxRepository(
      database,
      new FeedbackCampaignRepository(database),
    );
    const campaignId = "33333333-3333-4333-8333-333333333333";
    const terminalOutboxId = "44444444-4444-4444-8444-444444444444";

    await expect(
      repository.cancelQueuedOutboxForCampaign(
        { update } as never,
        campaignId,
        [terminalOutboxId],
      ),
    ).resolves.toBe(1);

    const [predicate] = where.mock.calls[0] as [SQL];
    const query = new PgDialect().sqlToQuery(predicate);
    expect(query.sql).toContain('"message_outbox"."id" not in');
    expect(query.sql).toContain('"message_outbox"."send_started_at" is null');
    expect(query.params).toEqual([
      campaignId,
      terminalOutboxId,
      "pending",
      "held",
      "claimed",
    ]);
  });

  it("preserves only the terminal winner when a close retracts older work", async () => {
    const returning = vi.fn().mockResolvedValue([{ id: "older" }]);
    const where = vi.fn().mockReturnValue({ returning });
    const set = vi.fn().mockReturnValue({ where });
    const update = vi.fn().mockReturnValue({ set });
    const database = {
      db: {},
      transaction: vi.fn(),
    } as unknown as DatabaseService;
    const repository = new FeedbackOutboxRepository(
      database,
      new FeedbackCampaignRepository(database),
    );
    const conversationId = "33333333-3333-4333-8333-333333333333";
    const winnerId = "44444444-4444-4444-8444-444444444444";

    await expect(
      repository.cancelQueuedOutboxForConversationExceptId(
        { update } as never,
        conversationId,
        winnerId,
      ),
    ).resolves.toBe(1);

    const [predicate] = where.mock.calls[0] as [SQL];
    const query = new PgDialect().sqlToQuery(predicate);
    expect(query.sql).toContain('"message_outbox"."id" <>');
    expect(query.sql).toContain('"message_outbox"."send_started_at" is null');
    expect(query.params).toEqual([
      conversationId,
      winnerId,
      "pending",
      "held",
      "claimed",
    ]);
  });

  it("cancels every retractable row when a terminal close has no copy", async () => {
    const returning = vi.fn().mockResolvedValue([]);
    const where = vi.fn().mockReturnValue({ returning });
    const set = vi.fn().mockReturnValue({ where });
    const update = vi.fn().mockReturnValue({ set });
    const database = {
      db: {},
      transaction: vi.fn(),
    } as unknown as DatabaseService;
    const repository = new FeedbackOutboxRepository(
      database,
      new FeedbackCampaignRepository(database),
    );
    const conversationId = "33333333-3333-4333-8333-333333333333";

    await repository.cancelQueuedOutboxForConversationExceptId(
      { update } as never,
      conversationId,
      null,
    );

    const [predicate] = where.mock.calls[0] as [SQL];
    const query = new PgDialect().sqlToQuery(predicate);
    expect(query.sql).not.toContain('"message_outbox"."id" <>');
    expect(query.params).toEqual([
      conversationId,
      "pending",
      "held",
      "claimed",
    ]);
  });

  it("cancels one stale row through the same pre-send fence", async () => {
    const row = { id: "11111111-1111-4111-8111-111111111111" };
    const returning = vi.fn().mockResolvedValue([row]);
    const where = vi.fn().mockReturnValue({ returning });
    const set = vi.fn().mockReturnValue({ where });
    const update = vi.fn().mockReturnValue({ set });
    const database = {
      db: {},
      transaction: vi.fn(),
    } as unknown as DatabaseService;
    const repository = new FeedbackOutboxRepository(
      database,
      new FeedbackCampaignRepository(database),
    );

    await expect(
      repository.cancelQueuedOutboxById(
        { update } as never,
        row.id,
        "terminal_transition_superseded",
      ),
    ).resolves.toEqual(row);
    expect(set).toHaveBeenCalledWith({
      status: "cancelled",
      claimExpiresAt: null,
      lastError: "terminal_transition_superseded",
      updatedAt: expect.any(Date),
    });
    const [predicate] = where.mock.calls[0] as [SQL];
    const query = new PgDialect().sqlToQuery(predicate);
    expect(query.sql).toContain('"message_outbox"."id" =');
    expect(query.sql).toContain('"message_outbox"."send_started_at" is null');
    expect(query.params).toEqual([row.id, "pending", "held", "claimed"]);
  });
});
