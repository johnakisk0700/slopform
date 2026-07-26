import type { Queue } from "bullmq";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  QUEUE_SETTLE_TIMEOUT_MS,
  QueueLifecycleService,
} from "./queue-lifecycle.service.js";

afterEach(() => {
  vi.useRealTimers();
});

function createQueue(name: string, waitUntilReady: () => Promise<unknown>) {
  return { name, waitUntilReady: vi.fn(waitUntilReady) } as unknown as Queue;
}

describe("QueueLifecycleService", () => {
  it("waits for every producer connection before shutdown continues", async () => {
    let settle: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const queues = [
      createQueue("assistant", () => pending),
      createQueue("email-delivery", () => pending),
      createQueue("feedback", () => pending),
      createQueue("reference", () => pending),
    ];
    const lifecycle = new QueueLifecycleService(...queueTuple(queues));

    let finished = false;
    const shutdown = lifecycle
      .beforeApplicationShutdown()
      .then(() => (finished = true));

    await Promise.resolve();
    expect(finished).toBe(false);

    settle?.();
    await shutdown;

    expect(finished).toBe(true);
    for (const queue of queues) {
      expect(queue.waitUntilReady).toHaveBeenCalledOnce();
    }
  });

  it("bounds the wait so an unreachable Redis cannot hold shutdown open", async () => {
    vi.useFakeTimers();
    const queues = [
      createQueue("assistant", () => new Promise(() => undefined)),
      createQueue("email-delivery", () => new Promise(() => undefined)),
      createQueue("feedback", () => new Promise(() => undefined)),
      createQueue("reference", () => new Promise(() => undefined)),
    ];
    const lifecycle = new QueueLifecycleService(...queueTuple(queues));

    const shutdown = lifecycle.beforeApplicationShutdown();
    await vi.advanceTimersByTimeAsync(QUEUE_SETTLE_TIMEOUT_MS);

    await expect(shutdown).resolves.toBeUndefined();
  });

  it("keeps shutting down when a connection settles as a failure", async () => {
    const queues = [
      createQueue("assistant", () => Promise.reject(new Error("no redis"))),
      createQueue("email-delivery", () => Promise.resolve()),
      createQueue("feedback", () => Promise.resolve()),
      createQueue("reference", () => Promise.resolve()),
    ];
    const lifecycle = new QueueLifecycleService(...queueTuple(queues));

    await expect(
      lifecycle.beforeApplicationShutdown(),
    ).resolves.toBeUndefined();
  });
});

function queueTuple(queues: readonly Queue[]): [Queue, Queue, Queue, Queue] {
  const [assistant, email, feedback, reference] = queues;
  return [assistant!, email!, feedback!, reference!];
}
