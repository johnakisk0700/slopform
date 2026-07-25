import { describe, expect, it, vi } from "vitest";

import type { DatabaseService } from "../../infrastructure/database/database.service.js";
import {
  FEEDBACK_OUTBOX_RECOVERY_MS,
  PostEventFeedbackRepository,
} from "./post-event-feedback.repository.js";

describe("PostEventFeedbackRepository outbox lease", () => {
  it("claims pending rows with FOR UPDATE SKIP LOCKED and never selects held", async () => {
    const campaignId = "89eccaa5-9ce6-4dcf-a630-5e35e4ec6f0d";
    const outboxId = "11111111-1111-4111-8111-111111111111";
    const returning = vi
      .fn()
      .mockResolvedValue([{ id: outboxId, status: "sending", campaignId }]);
    const whereUpdate = vi.fn().mockReturnValue({ returning });
    const set = vi.fn().mockReturnValue({ where: whereUpdate });
    const update = vi.fn().mockReturnValue({ set });

    const forUpdate = vi.fn().mockResolvedValue([
      {
        id: outboxId,
        status: "pending",
        campaignId,
      },
    ]);
    const limit = vi.fn().mockReturnValue({ for: forUpdate });
    const orderBy = vi.fn().mockReturnValue({ limit });
    const whereSelect = vi.fn().mockReturnValue({ orderBy });
    const from = vi.fn().mockImplementation(() => ({ where: whereSelect }));
    const select = vi.fn().mockReturnValue({ from });

    // Second select is findCampaignById inside the claim filter.
    const campaignLimit = vi
      .fn()
      .mockResolvedValue([{ id: campaignId, status: "launched" }]);
    const campaignWhere = vi.fn().mockReturnValue({ limit: campaignLimit });
    const campaignFrom = vi.fn().mockReturnValue({ where: campaignWhere });
    let selectCalls = 0;
    select.mockImplementation(() => {
      selectCalls += 1;
      if (selectCalls === 1) {
        return { from };
      }
      return { from: campaignFrom };
    });

    const transaction = vi.fn(async (work: (tx: unknown) => Promise<unknown>) =>
      work({ select, update }),
    );
    const repository = new PostEventFeedbackRepository({
      transaction,
      db: {},
    } as unknown as DatabaseService);

    const now = new Date("2026-07-25T12:00:00.000Z");
    await repository.claimOutboxBatch(now, 10);

    expect(forUpdate).toHaveBeenCalledWith("update", { skipLocked: true });
    expect(set).toHaveBeenCalledWith({ status: "sending", updatedAt: now });
  });

  it("does not lease rows for a paused campaign", async () => {
    const campaignId = "89eccaa5-9ce6-4dcf-a630-5e35e4ec6f0d";
    const outboxId = "11111111-1111-4111-8111-111111111111";
    const update = vi.fn();
    const forUpdate = vi
      .fn()
      .mockResolvedValue([{ id: outboxId, status: "pending", campaignId }]);
    const limit = vi.fn().mockReturnValue({ for: forUpdate });
    const orderBy = vi.fn().mockReturnValue({ limit });
    const whereSelect = vi.fn().mockReturnValue({ orderBy });
    const from = vi.fn().mockReturnValue({ where: whereSelect });
    const campaignLimit = vi
      .fn()
      .mockResolvedValue([{ id: campaignId, status: "paused" }]);
    const campaignWhere = vi.fn().mockReturnValue({ limit: campaignLimit });
    const campaignFrom = vi.fn().mockReturnValue({ where: campaignWhere });
    let selectCalls = 0;
    const select = vi.fn().mockImplementation(() => {
      selectCalls += 1;
      if (selectCalls === 1) {
        return { from };
      }
      return { from: campaignFrom };
    });

    const repository = new PostEventFeedbackRepository({
      transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) =>
        work({ select, update }),
      ),
      db: {},
    } as unknown as DatabaseService);

    await expect(
      repository.claimOutboxBatch(new Date("2026-07-25T12:00:00.000Z"), 10),
    ).resolves.toEqual([]);
    expect(update).not.toHaveBeenCalled();
  });

  it("releases a lease only when no provider attempt was recorded", async () => {
    const returning = vi
      .fn()
      .mockResolvedValue([
        { id: "11111111-1111-4111-8111-111111111111", status: "pending" },
      ]);
    const where = vi.fn().mockReturnValue({ returning });
    const set = vi.fn().mockReturnValue({ where });
    const update = vi.fn().mockReturnValue({ set });
    const repository = new PostEventFeedbackRepository({
      db: { update },
      transaction: vi.fn(),
    } as unknown as DatabaseService);

    const now = new Date("2026-07-25T12:00:00.000Z");
    await repository.releaseOutboxLease(
      "11111111-1111-4111-8111-111111111111",
      now,
    );

    expect(set).toHaveBeenCalledWith({ status: "pending", updatedAt: now });
    expect(where).toHaveBeenCalled();
  });

  it("exposes the recovery horizon used by stale sending reclaim", () => {
    expect(FEEDBACK_OUTBOX_RECOVERY_MS).toBe(5 * 60_000);
  });
});
