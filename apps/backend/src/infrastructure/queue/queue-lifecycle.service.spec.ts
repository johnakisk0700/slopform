import type { Queue } from "bullmq";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ASSISTANT_QUEUE,
  EMAIL_QUEUE,
  FEEDBACK_CONVERSATION_QUEUE,
  FEEDBACK_INGRESS_QUEUE,
  FEEDBACK_MAINTENANCE_QUEUE,
  FEEDBACK_QUEUE,
  FEEDBACK_SUMMARY_QUEUE,
  REFERENCE_QUEUE,
} from "./queue.constants.js";
import {
  QUEUE_SETTLE_TIMEOUT_MS,
  QueueLifecycleService,
} from "./queue-lifecycle.service.js";

/**
 * Every queue the service settles, in constructor order. Adding a queue to the
 * service without adding it here fails to compile, which is the point: a queue
 * left out of shutdown is a connection that can hold the process open.
 */
const SETTLED_QUEUES = [
  ASSISTANT_QUEUE,
  EMAIL_QUEUE,
  FEEDBACK_QUEUE,
  FEEDBACK_INGRESS_QUEUE,
  FEEDBACK_CONVERSATION_QUEUE,
  FEEDBACK_SUMMARY_QUEUE,
  FEEDBACK_MAINTENANCE_QUEUE,
  REFERENCE_QUEUE,
] as const;

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
    const queues = SETTLED_QUEUES.map((name) =>
      createQueue(name, () => pending),
    );
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
    const queues = SETTLED_QUEUES.map((name) =>
      createQueue(name, () => new Promise(() => undefined)),
    );
    const lifecycle = new QueueLifecycleService(...queueTuple(queues));

    const shutdown = lifecycle.beforeApplicationShutdown();
    await vi.advanceTimersByTimeAsync(QUEUE_SETTLE_TIMEOUT_MS);

    await expect(shutdown).resolves.toBeUndefined();
  });

  it("keeps shutting down when a connection settles as a failure", async () => {
    const queues = SETTLED_QUEUES.map((name, index) =>
      createQueue(name, () =>
        index === 0 ? Promise.reject(new Error("no redis")) : Promise.resolve(),
      ),
    );
    const lifecycle = new QueueLifecycleService(...queueTuple(queues));

    await expect(
      lifecycle.beforeApplicationShutdown(),
    ).resolves.toBeUndefined();
  });
});

function queueTuple(
  queues: readonly Queue[],
): [Queue, Queue, Queue, Queue, Queue, Queue, Queue, Queue] {
  const [
    assistant,
    email,
    feedback,
    feedbackIngress,
    feedbackConversation,
    feedbackSummary,
    feedbackMaintenance,
    reference,
  ] = queues;
  return [
    assistant!,
    email!,
    feedback!,
    feedbackIngress!,
    feedbackConversation!,
    feedbackSummary!,
    feedbackMaintenance!,
    reference!,
  ];
}
