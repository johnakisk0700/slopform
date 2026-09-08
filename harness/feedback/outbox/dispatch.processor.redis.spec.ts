import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { Queue, Worker } from "bullmq";
import { describe, expect, it, vi } from "vitest";

import { redisWorkerConnectionFromUrl } from "../../../apps/backend/src/infrastructure/queue/redis-connection.js";
import { FEEDBACK_JOB_NAMES } from "../../../apps/backend/src/modules/post-event-feedback/jobs.schemas.js";
import { FeedbackOutboxDispatchProcessor } from "../../../apps/backend/src/modules/post-event-feedback/outbox/dispatch.processor.js";
import type { MessageOutboxDispatcherService } from "../../../apps/backend/src/modules/post-event-feedback/outbox/dispatcher.service.js";

const redisUrl = process.env.FEEDBACK_OUTBOX_TEST_REDIS_URL;

describe.skipIf(!redisUrl)("outbox polling with real BullMQ", () => {
  it("shares one schedule, adapts, and resumes after worker restart and a failed poll", async () => {
    const connection = redisWorkerConnectionFromUrl(redisUrl!);
    const name = `outbox-poll-test-${randomUUID()}`;
    const queue = new Queue(name, { connection });
    const processors: FeedbackOutboxDispatchProcessor[] = [];
    const errors: Error[] = [];
    let busy = true;
    let failNext = false;
    let active = 0;
    let maxActive = 0;
    let failed = 0;
    let completed = 0;
    const dispatcher = {
      async dispatchBatch() {
        await sleep(5);
        if (failNext) {
          failNext = false;
          throw new Error("temporary database failure");
        }
        return { claimedCount: busy ? 4 : 0, quarantinedCount: 0, items: [] };
      },
    } as unknown as MessageOutboxDispatcherService;

    async function startReplica() {
      const processor = new FeedbackOutboxDispatchProcessor(queue, dispatcher);
      await processor.onApplicationBootstrap();
      const worker = new Worker(
        name,
        async (job) => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          try {
            return await processor.process(job);
          } finally {
            active -= 1;
          }
        },
        { connection, concurrency: 1 },
      );
      worker.on("completed", () => {
        completed += 1;
      });
      worker.on("failed", () => {
        failed += 1;
      });
      worker.on("error", (error) => errors.push(error));
      vi.spyOn(processor, "worker", "get").mockReturnValue(worker);
      processors.push(processor);
      await worker.waitUntilReady();
      return processor;
    }

    try {
      const first = await startReplica();
      const second = await startReplica();
      await vi.waitFor(
        async () => {
          expect(
            (await queue.getJobScheduler(FEEDBACK_JOB_NAMES.dispatchOutboxV2))
              ?.every,
          ).toBe(250);
          expect(completed).toBeGreaterThanOrEqual(2);
        },
        { timeout: 10_000, interval: 25 },
      );
      expect(await queue.getJobSchedulersCount()).toBe(1);
      expect(maxActive).toBe(1);
      await Promise.all([
        first.beforeApplicationShutdown(),
        second.beforeApplicationShutdown(),
      ]);
      expect(active).toBe(0);

      busy = false;
      failNext = true;
      const completedBeforeRestart = completed;
      await startReplica();
      await vi.waitFor(
        async () => {
          expect(failed).toBe(1);
          expect(completed).toBeGreaterThan(completedBeforeRestart);
          expect(
            (await queue.getJobScheduler(FEEDBACK_JOB_NAMES.dispatchOutboxV2))
              ?.every,
          ).toBe(5_000);
        },
        { timeout: 15_000, interval: 25 },
      );
      expect(await queue.getJobSchedulersCount()).toBe(1);
      expect(maxActive).toBe(1);
      expect(errors).toEqual([]);
    } finally {
      await Promise.all(
        processors.map((processor) => processor.beforeApplicationShutdown()),
      );
      await queue.obliterate({ force: true });
      await queue.close();
      vi.restoreAllMocks();
    }
  }, 30_000);
});
