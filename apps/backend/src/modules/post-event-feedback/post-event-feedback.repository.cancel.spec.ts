import { describe, expect, it, vi } from "vitest";

import { messageOutbox } from "@join-the-six/database";

import type { DatabaseService } from "../../infrastructure/database/database.service.js";
import { FeedbackCampaignRepository } from "./campaign/campaign.repository.js";
import { FeedbackOutboxRepository } from "./outbox/outbox.repository.js";

describe("FeedbackOutboxRepository cancelQueuedOutboxForConversation", () => {
  it("cancels only pending and held rows for the conversation", async () => {
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
      updatedAt: expect.any(Date),
    });
    expect(where).toHaveBeenCalled();
  });
});
