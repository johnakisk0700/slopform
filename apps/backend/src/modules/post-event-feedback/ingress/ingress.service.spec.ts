import { Logger } from "@nestjs/common";
import type { AppTransaction } from "@join-the-six/database";
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { DatabaseService } from "../../../infrastructure/database/database.service.js";
import {
  PostEventFeedbackEnqueueError,
  PostEventFeedbackIngressService,
} from "./ingress.service.js";
import type { FeedbackIngressRepository } from "./ingress.repository.js";
import type { FeedbackMaterializeWakeupService } from "./materialize-wakeup.service.js";
import { FEEDBACK_OBSERVED_TEXT_HARD_LIMIT } from "../jobs.schemas.js";

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
    const { service, repository, wakeups } = createService({ inserted: true });

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
    expect(wakeups.ensurePendingQueued).toHaveBeenCalledWith({
      ingressId,
      correlationId: "correlation-1",
    });
  });

  it("re-enqueues a redelivered message that the unique constraint deduplicated", async () => {
    const { service, repository, wakeups } = createService({ inserted: false });

    await expect(
      service.recordObservedMessage(observed, "correlation-2"),
    ).resolves.toEqual({ ingressId, inserted: false });

    expect(repository.insertIngressIfAbsent).toHaveBeenCalledTimes(1);
    // The first delivery may have crashed before the enqueue, so a redelivery
    // must still reconcile the wake-up. The job id keeps it from running twice.
    expect(wakeups.ensurePendingQueued).toHaveBeenCalledTimes(1);
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
      wakeupError: new Error("redis unavailable"),
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
  wakeupError?: Error;
  /** What the already-stored row holds. Differing text is an edit, not a duplicate. */
  storedText?: string | null;
}): {
  service: PostEventFeedbackIngressService;
  repository: { insertIngressIfAbsent: ReturnType<typeof vi.fn> };
  wakeups: { ensurePendingQueued: ReturnType<typeof vi.fn> };
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
  const wakeups = {
    ensurePendingQueued: options.wakeupError
      ? vi.fn().mockRejectedValue(options.wakeupError)
      : vi.fn().mockResolvedValue(`feedback-materialize-v1-${ingressId}`),
  };
  const database = {
    transaction: async <T>(work: (tx: AppTransaction) => Promise<T>) =>
      work({} as AppTransaction),
  };

  return {
    service: new PostEventFeedbackIngressService(
      wakeups as unknown as FeedbackMaterializeWakeupService,
      database as unknown as DatabaseService,
      repository as unknown as FeedbackIngressRepository,
    ),
    repository,
    wakeups,
  };
}
