import { Logger } from "@nestjs/common";
import type { AppTransaction } from "@join-the-six/database";
import type { Queue } from "bullmq";
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { DatabaseService } from "../../../infrastructure/database/database.service.js";
import {
  PostEventFeedbackEnqueueError,
  PostEventFeedbackIngressService,
} from "./ingress.service.js";
import type { FeedbackIngressRepository } from "./ingress.repository.js";
import {
  FEEDBACK_OBSERVED_TEXT_HARD_LIMIT,
  type FeedbackJobData,
  type FeedbackJobName,
} from "../jobs.schemas.js";

const ingressId = "b1c9e0a4-2c65-4a29-9a2e-2d0a3f2e1b77";
const observed = {
  providerMessageId: "provider-message-1",
  chatJid: "306900000000@s.whatsapp.net",
  direction: "inbound" as const,
  phoneE164: "+306900000000",
  text: "Πέρασα τέλεια",
  observedAt: new Date("2026-07-25T10:05:00.000Z"),
};

describe("PostEventFeedbackIngressService", () => {
  beforeAll(() => {
    Logger.overrideLogger(false);
  });

  it("performs one durable insert and one deterministic enqueue", async () => {
    const { service, repository, queue } = createService({ inserted: true });

    await expect(
      service.recordObservedMessage(observed, "correlation-1"),
    ).resolves.toEqual({ ingressId, inserted: true });

    expect(repository.insertIngressIfAbsent).toHaveBeenCalledTimes(1);
    expect(repository.insertIngressIfAbsent).toHaveBeenCalledWith(
      expect.anything(),
      {
        providerMessageId: "provider-message-1",
        chatJid: "306900000000@s.whatsapp.net",
        direction: "inbound",
        phoneE164: "+306900000000",
        text: "Πέρασα τέλεια",
        observedAt: observed.observedAt,
      },
    );
    expect(queue.add).toHaveBeenCalledWith(
      "feedback.materialize.v1",
      {
        schemaVersion: 1,
        ingressId,
        correlationId: "correlation-1",
      },
      { jobId: `feedback-materialize-v1-${ingressId}` },
    );
  });

  it("re-enqueues a redelivered message that the unique constraint deduplicated", async () => {
    const { service, repository, queue } = createService({ inserted: false });

    await expect(
      service.recordObservedMessage(observed, "correlation-2"),
    ).resolves.toEqual({ ingressId, inserted: false });

    expect(repository.insertIngressIfAbsent).toHaveBeenCalledTimes(1);
    // The first delivery may have crashed before the enqueue, so a redelivery
    // must still queue. The job id keeps it from running twice.
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it("records a redelivery whose words changed as its own observation", async () => {
    // WhatsApp lets people edit what they sent. The unique key on
    // `(chat_jid, provider_message_id)` swallowed the corrected version, so a
    // deliberate correction about another participant simply vanished.
    const { service, repository } = createService({
      inserted: false,
      storedText: "ο Κώστας ήταν χάλια",
    });

    await service.recordObservedMessage(observed, "correlation-edit");

    expect(repository.insertIngressIfAbsent).toHaveBeenCalledTimes(2);
    const second = repository.insertIngressIfAbsent.mock.calls[1]?.[1] as {
      providerMessageId: string;
      text: string;
    };
    expect(second.text).toBe(observed.text);
    // A distinct, text-derived id: the same edit redelivered collapses on the
    // unique key exactly as an ordinary duplicate does.
    expect(second.providerMessageId).not.toBe(observed.providerMessageId);
    expect(second.providerMessageId).toContain(observed.providerMessageId);
  });

  it("refuses to acknowledge a message it could not queue", async () => {
    const { service } = createService({
      inserted: true,
      queueError: new Error("redis unavailable"),
    });

    await expect(
      service.recordObservedMessage(observed, "correlation-3"),
    ).rejects.toBeInstanceOf(PostEventFeedbackEnqueueError);
  });

  it("rejects an unbounded provider payload before it reaches the database", async () => {
    const { service, repository } = createService({ inserted: true });

    await expect(
      service.recordObservedMessage(
        {
          ...observed,
          text: "x".repeat(FEEDBACK_OBSERVED_TEXT_HARD_LIMIT + 1),
        },
        "correlation-4",
      ),
    ).rejects.toThrow();
    expect(repository.insertIngressIfAbsent).not.toHaveBeenCalled();
  });
});

function createService(options: {
  inserted: boolean;
  queueError?: Error;
  /** What the already-stored row holds. Differing text is an edit, not a duplicate. */
  storedText?: string | null;
}): {
  service: PostEventFeedbackIngressService;
  repository: { insertIngressIfAbsent: ReturnType<typeof vi.fn> };
  queue: { add: ReturnType<typeof vi.fn> };
} {
  const repository = {
    insertIngressIfAbsent: vi.fn().mockResolvedValue({
      row: {
        id: ingressId,
        direction: observed.direction,
        text: options.storedText ?? observed.text,
      },
      inserted: options.inserted,
    }),
  };
  const queue = {
    add: options.queueError
      ? vi.fn().mockRejectedValue(options.queueError)
      : vi
          .fn()
          .mockResolvedValue({ id: `feedback-materialize-v1-${ingressId}` }),
  };
  const database = {
    transaction: async <T>(work: (tx: AppTransaction) => Promise<T>) =>
      work({} as AppTransaction),
  };

  return {
    service: new PostEventFeedbackIngressService(
      queue as unknown as Queue<FeedbackJobData, void, FeedbackJobName>,
      database as unknown as DatabaseService,
      repository as unknown as FeedbackIngressRepository,
    ),
    repository,
    queue,
  };
}
