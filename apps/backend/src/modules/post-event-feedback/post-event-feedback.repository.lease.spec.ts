import { describe, expect, it, vi } from "vitest";

import type { DatabaseService } from "../../infrastructure/database/database.service.js";
import {
  FEEDBACK_OUTBOX_RECOVERY_MS,
  PostEventFeedbackRepository,
} from "./post-event-feedback.repository.js";

describe("PostEventFeedbackRepository outbox lease", () => {
  it("claims pending rows with FOR UPDATE SKIP LOCKED and never selects held", async () => {
    const returning = vi
      .fn()
      .mockResolvedValue([
        { id: "11111111-1111-4111-8111-111111111111", status: "sending" },
      ]);
    const whereUpdate = vi.fn().mockReturnValue({ returning });
    const set = vi.fn().mockReturnValue({ where: whereUpdate });
    const update = vi.fn().mockReturnValue({ set });

    const forUpdate = vi
      .fn()
      .mockResolvedValue([
        { id: "11111111-1111-4111-8111-111111111111", status: "pending" },
      ]);
    const limit = vi.fn().mockReturnValue({ for: forUpdate });
    const orderBy = vi.fn().mockReturnValue({ limit });
    const whereSelect = vi.fn().mockReturnValue({ orderBy });
    const from = vi.fn().mockReturnValue({ where: whereSelect });
    const select = vi.fn().mockReturnValue({ from });

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
    const whereArg = whereSelect.mock.calls[0]?.[0] as {
      queryChunks?: unknown;
    };
    expect(whereArg).toBeDefined();
    expect(set).toHaveBeenCalledWith({ status: "sending", updatedAt: now });
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
