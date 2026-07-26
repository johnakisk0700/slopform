import type { Queue } from "bullmq";
import { describe, expect, it, vi } from "vitest";

import type { FeedbackOutboxRepository } from "./outbox.repository.js";
import {
  FEEDBACK_CAMPAIGN_STAGGER_MS,
  MessageOutboxRelayError,
  MessageOutboxRelayService,
} from "./relay.service.js";
import {
  FEEDBACK_JOB_NAMES,
  type FeedbackJobData,
  type FeedbackJobName,
} from "../jobs.schemas.js";

const pendingRow = {
  id: "66de52a8-1a26-4cbb-b8d1-fcf8bdc2dd51",
  conversationId: "7c57f3b8-2b13-48f5-8730-18ac71f490cd",
  campaignId: "89eccaa5-9ce6-4dcf-a630-5e35e4ec6f0d",
  kind: "reply" as const,
  body: "Ευχαριστούμε!",
  status: "sending" as const,
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
  createdAt: new Date("2026-07-25T00:00:00.000Z"),
  updatedAt: new Date("2026-07-25T00:00:00.000Z"),
};

describe("MessageOutboxRelayService", () => {
  it("enqueues a stable deliver job id for each leased row", async () => {
    const queue = { add: vi.fn().mockResolvedValue({ id: "job" }) };
    const repository = {
      claimOutboxBatch: vi.fn().mockResolvedValue([pendingRow]),
      releaseOutboxLease: vi.fn(),
    };
    const relay = new MessageOutboxRelayService(
      queue as unknown as Queue<FeedbackJobData, void, FeedbackJobName>,
      repository as unknown as FeedbackOutboxRepository,
    );

    await expect(
      relay.relay(new Date("2026-07-25T00:00:00.000Z")),
    ).resolves.toBe(1);
    expect(queue.add).toHaveBeenCalledWith(
      FEEDBACK_JOB_NAMES.deliverV1,
      {
        schemaVersion: 1,
        outboxId: pendingRow.id,
        correlationId: pendingRow.id,
      },
      expect.objectContaining({
        jobId: `feedback-deliver-v1-${pendingRow.id}`,
        attempts: 1,
      }),
    );
    expect(repository.releaseOutboxLease).not.toHaveBeenCalled();
  });

  it("staggers campaign intro and reminder jobs in the same batch", async () => {
    const queue = { add: vi.fn().mockResolvedValue({ id: "job" }) };
    const intros = [
      {
        ...pendingRow,
        id: "11111111-1111-4111-8111-111111111111",
        kind: "intro" as const,
      },
      {
        ...pendingRow,
        id: "22222222-2222-4222-8222-222222222222",
        kind: "intro" as const,
      },
      {
        ...pendingRow,
        id: "33333333-3333-4333-8333-333333333333",
        kind: "reminder" as const,
      },
    ];
    const repository = {
      claimOutboxBatch: vi.fn().mockResolvedValue(intros),
      releaseOutboxLease: vi.fn(),
    };
    const relay = new MessageOutboxRelayService(
      queue as unknown as Queue<FeedbackJobData, void, FeedbackJobName>,
      repository as unknown as FeedbackOutboxRepository,
    );

    await relay.relay();

    expect(queue.add).toHaveBeenNthCalledWith(
      1,
      FEEDBACK_JOB_NAMES.deliverV1,
      expect.any(Object),
      expect.not.objectContaining({ delay: expect.any(Number) }),
    );
    expect(queue.add).toHaveBeenNthCalledWith(
      2,
      FEEDBACK_JOB_NAMES.deliverV1,
      expect.any(Object),
      expect.objectContaining({ delay: FEEDBACK_CAMPAIGN_STAGGER_MS }),
    );
    expect(queue.add).toHaveBeenNthCalledWith(
      3,
      FEEDBACK_JOB_NAMES.deliverV1,
      expect.any(Object),
      expect.objectContaining({ delay: FEEDBACK_CAMPAIGN_STAGGER_MS * 2 }),
    );
  });

  it("releases the lease when enqueueing fails", async () => {
    const queue = { add: vi.fn().mockRejectedValue(new Error("redis secret")) };
    const repository = {
      claimOutboxBatch: vi.fn().mockResolvedValue([pendingRow]),
      releaseOutboxLease: vi.fn().mockResolvedValue(pendingRow),
    };
    const relay = new MessageOutboxRelayService(
      queue as unknown as Queue<FeedbackJobData, void, FeedbackJobName>,
      repository as unknown as FeedbackOutboxRepository,
    );

    await expect(relay.relay()).rejects.toBeInstanceOf(MessageOutboxRelayError);
    expect(repository.releaseOutboxLease).toHaveBeenCalledWith(
      pendingRow.id,
      expect.any(Date),
    );
  });
});
