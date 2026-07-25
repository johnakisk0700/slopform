import type { Queue } from "bullmq";
import { describe, expect, it, vi } from "vitest";

import type { EmailRepository } from "./email.repository.js";
import {
  EmailOutboxRelayError,
  EmailOutboxRelayService,
} from "./email-outbox-relay.service.js";
import {
  EMAIL_JOB_NAMES,
  type EmailJobData,
  type EmailJobName,
} from "./email.schemas.js";

const event = {
  id: "66de52a8-1a26-4cbb-b8d1-fcf8bdc2dd51",
  deliveryId: "7c57f3b8-2b13-48f5-8730-18ac71f490cd",
  eventType: "email.delivery.requested.v1",
  correlationId: "request-1",
  status: "publishing",
  publishAttempts: 1,
  availableAt: new Date("2026-07-25T00:00:00.000Z"),
  leaseToken: "89eccaa5-9ce6-4dcf-a630-5e35e4ec6f0d",
  leaseUntil: new Date("2026-07-25T00:01:00.000Z"),
  lastErrorCode: null,
  createdAt: new Date("2026-07-25T00:00:00.000Z"),
  updatedAt: new Date("2026-07-25T00:00:00.000Z"),
  dispatchedAt: null,
  consumedAt: null,
};

describe("EmailOutboxRelayService", () => {
  it("enqueues identifiers only and acknowledges the leased outbox row", async () => {
    const queue = { add: vi.fn().mockResolvedValue({ id: "job" }) };
    const repository = {
      claimOutboxBatch: vi.fn().mockResolvedValue([event]),
      markOutboxDispatched: vi.fn().mockResolvedValue(undefined),
      releaseOutbox: vi.fn(),
    };
    const relay = new EmailOutboxRelayService(
      queue as unknown as Queue<EmailJobData, void, EmailJobName>,
      repository as unknown as EmailRepository,
    );

    await expect(
      relay.relay(new Date("2026-07-25T00:00:00.000Z")),
    ).resolves.toBe(1);
    expect(queue.add).toHaveBeenCalledWith(
      EMAIL_JOB_NAMES.deliverV1,
      {
        schemaVersion: 1,
        deliveryId: event.deliveryId,
        outboxEventId: event.id,
        correlationId: "request-1",
      },
      expect.objectContaining({
        jobId: `email-deliver-v1-${event.id}`,
        attempts: 1,
      }),
    );
    expect(repository.markOutboxDispatched).toHaveBeenCalledWith(
      event,
      expect.any(Date),
      expect.any(Date),
    );
  });

  it("releases the database lease with a safe code when enqueueing fails", async () => {
    const queue = { add: vi.fn().mockRejectedValue(new Error("redis secret")) };
    const repository = {
      claimOutboxBatch: vi.fn().mockResolvedValue([event]),
      markOutboxDispatched: vi.fn(),
      releaseOutbox: vi.fn().mockResolvedValue(undefined),
    };
    const relay = new EmailOutboxRelayService(
      queue as unknown as Queue<EmailJobData, void, EmailJobName>,
      repository as unknown as EmailRepository,
    );

    await expect(relay.relay()).rejects.toBeInstanceOf(EmailOutboxRelayError);
    expect(repository.releaseOutbox).toHaveBeenCalledWith(
      event,
      expect.any(Date),
      "queue_unavailable",
    );
  });
});
