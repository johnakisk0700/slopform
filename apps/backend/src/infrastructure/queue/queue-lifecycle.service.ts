import { InjectQueue } from "@nestjs/bullmq";
import {
  Injectable,
  Logger,
  type BeforeApplicationShutdown,
} from "@nestjs/common";
import type { Queue } from "bullmq";

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

// A connection that never opened cannot leave a command in flight, so closing
// it is already safe. The bound only exists so a Redis outage cannot hold the
// process open; it must stay well below the deployment shutdown grace.
export const QUEUE_SETTLE_TIMEOUT_MS = 5_000;

/**
 * Settles every producer connection before Nest closes the Queues.
 *
 * BullMQ opens a connection lazily and keeps `RedisConnection.init()` pending
 * across a Redis `INFO` round trip that runs after the socket is already ready.
 * Closing a Queue inside that window hard-disconnects the client, so ioredis
 * flushes the in-flight `INFO` with `Connection is closed.`, and BullMQ re-emits
 * that rejection on a connection whose listeners `close()` has just removed.
 * No listener is left to receive it and the process sees an unhandled rejection.
 *
 * `beforeApplicationShutdown` runs to completion before any
 * `onApplicationShutdown` hook, which is where the Nest BullMQ integration
 * closes each Queue. Waiting here means close always takes the drained `quit()`
 * path instead of the hard disconnect.
 */
@Injectable()
export class QueueLifecycleService implements BeforeApplicationShutdown {
  private readonly logger = new Logger(QueueLifecycleService.name);
  private readonly queues: readonly Queue[];

  constructor(
    @InjectQueue(ASSISTANT_QUEUE) assistant: Queue,
    @InjectQueue(EMAIL_QUEUE) email: Queue,
    @InjectQueue(FEEDBACK_QUEUE) feedback: Queue,
    @InjectQueue(FEEDBACK_INGRESS_QUEUE) feedbackIngress: Queue,
    @InjectQueue(FEEDBACK_CONVERSATION_QUEUE) feedbackConversation: Queue,
    @InjectQueue(FEEDBACK_SUMMARY_QUEUE) feedbackSummary: Queue,
    @InjectQueue(FEEDBACK_MAINTENANCE_QUEUE) feedbackMaintenance: Queue,
    @InjectQueue(REFERENCE_QUEUE) reference: Queue,
  ) {
    this.queues = [
      assistant,
      email,
      feedback,
      feedbackIngress,
      feedbackConversation,
      feedbackSummary,
      feedbackMaintenance,
      reference,
    ];
  }

  async beforeApplicationShutdown(): Promise<void> {
    await Promise.all(this.queues.map((queue) => this.settle(queue)));
  }

  private async settle(queue: Queue): Promise<void> {
    let timeout: NodeJS.Timeout | undefined;

    try {
      await Promise.race([
        queue.waitUntilReady(),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            reject(
              new Error(
                `Queue connection did not settle within ${QUEUE_SETTLE_TIMEOUT_MS}ms`,
              ),
            );
          }, QUEUE_SETTLE_TIMEOUT_MS);
          timeout.unref();
        }),
      ]);
    } catch (error) {
      this.logger.debug({
        event: "queue.producer.settle_skipped",
        queue: queue.name,
        error: { name: error instanceof Error ? error.name : "UnknownError" },
      });
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }
}
