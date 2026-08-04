import type { Queue } from "bullmq";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FEEDBACK_JOB_NAMES } from "../jobs.schemas.js";
import type { MessageOutboxDispatcherService } from "./dispatcher.service.js";
import {
  FEEDBACK_OUTBOX_DISPATCH_INTERVAL_MS,
  FeedbackOutboxDispatcherLoop,
} from "./dispatcher-loop.service.js";

afterEach(() => vi.useRealTimers());

describe("FeedbackOutboxDispatcherLoop", () => {
  it("removes the relay scheduler before the first direct dispatch", async () => {
    const { loop, queue, dispatcher } = createLoop();

    await loop.onApplicationBootstrap();

    expect(queue.removeJobScheduler).toHaveBeenCalledWith(
      FEEDBACK_JOB_NAMES.relayOutboxV1,
    );
    expect(queue.removeJobScheduler).toHaveBeenCalledBefore(
      dispatcher.dispatchBatch,
    );
    await loop.beforeApplicationShutdown();
  });

  it("never overlaps a slow dispatch batch and drains it on shutdown", async () => {
    vi.useFakeTimers();
    let finish: (() => void) | undefined;
    const slow = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const { loop, dispatcher } = createLoop();
    dispatcher.dispatchBatch
      .mockResolvedValueOnce({
        claimedCount: 0,
        quarantinedCount: 0,
        items: [],
      })
      .mockImplementationOnce(async () => {
        await slow;
        return { claimedCount: 0, quarantinedCount: 0, items: [] };
      });

    await loop.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(FEEDBACK_OUTBOX_DISPATCH_INTERVAL_MS * 3);
    expect(dispatcher.dispatchBatch).toHaveBeenCalledTimes(2);

    let stopped = false;
    const shutdown = loop.beforeApplicationShutdown().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    finish?.();
    await shutdown;
  });
});

function createLoop() {
  const queue = { removeJobScheduler: vi.fn().mockResolvedValue(true) };
  const dispatcher = {
    dispatchBatch: vi.fn().mockResolvedValue({
      claimedCount: 0,
      quarantinedCount: 0,
      items: [],
    }),
  };
  return {
    loop: new FeedbackOutboxDispatcherLoop(
      queue as unknown as Queue,
      dispatcher as unknown as MessageOutboxDispatcherService,
    ),
    queue,
    dispatcher,
  };
}
