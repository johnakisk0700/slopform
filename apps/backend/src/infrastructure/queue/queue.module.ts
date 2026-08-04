import { BullModule, type BullRootModuleOptions } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";

import type { Environment } from "../config/environment.js";
import {
  QUEUE_PREFIX,
  QUEUE_PRODUCER_CONFIG,
  QUEUE_WORKER_CONFIG,
  ASSISTANT_QUEUE,
  EMAIL_QUEUE,
  FEEDBACK_CONVERSATION_QUEUE,
  FEEDBACK_INGRESS_QUEUE,
  FEEDBACK_MAINTENANCE_QUEUE,
  FEEDBACK_QUEUE,
  FEEDBACK_SUMMARY_QUEUE,
  REFERENCE_QUEUE,
} from "./queue.constants.js";
import { QueueHealthService } from "./queue-health.service.js";
import { QueueLifecycleService } from "./queue-lifecycle.service.js";
import {
  redisProducerConnectionFromUrl,
  redisWorkerConnectionFromUrl,
} from "./redis-connection.js";

/**
 * Retry, backoff and retention for every job this deployment enqueues.
 *
 * Producer and worker registrations share it because workers also publish
 * successor and repair wake-ups after durable intent is committed. The legacy
 * feedback V1 drain uses the same policy until those consumers are removed.
 *
 * A per-`add` option still wins. The email outbox relay uses that escape hatch
 * for its deliberate at-most-once enqueue contract.
 */
const DEFAULT_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: "exponential", delay: 1_000, jitter: 0.5 },
  removeOnComplete: { age: 86_400, count: 1_000 },
  removeOnFail: { age: 604_800, count: 5_000 },
  stackTraceLimit: 10,
} as const satisfies BullRootModuleOptions["defaultJobOptions"];

export function createQueueProducerOptions(
  redisUrl: string,
): BullRootModuleOptions {
  return {
    connection: redisProducerConnectionFromUrl(redisUrl),
    defaultJobOptions: { ...DEFAULT_JOB_OPTIONS },
    prefix: QUEUE_PREFIX,
  };
}

export function createQueueWorkerOptions(
  redisUrl: string,
): BullRootModuleOptions {
  return {
    connection: redisWorkerConnectionFromUrl(redisUrl),
    defaultJobOptions: { ...DEFAULT_JOB_OPTIONS },
    prefix: QUEUE_PREFIX,
  };
}

@Module({
  imports: [
    BullModule.forRootAsync(QUEUE_PRODUCER_CONFIG, {
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService<Environment, true>) =>
        createQueueProducerOptions(config.get("REDIS_URL", { infer: true })),
    }),
    BullModule.registerQueue({
      name: ASSISTANT_QUEUE,
      configKey: QUEUE_PRODUCER_CONFIG,
    }),
    BullModule.registerQueue({
      name: EMAIL_QUEUE,
      configKey: QUEUE_PRODUCER_CONFIG,
    }),
    BullModule.registerQueue({
      name: FEEDBACK_QUEUE,
      configKey: QUEUE_PRODUCER_CONFIG,
    }),
    BullModule.registerQueue({
      name: FEEDBACK_INGRESS_QUEUE,
      configKey: QUEUE_PRODUCER_CONFIG,
    }),
    BullModule.registerQueue({
      name: FEEDBACK_CONVERSATION_QUEUE,
      configKey: QUEUE_PRODUCER_CONFIG,
    }),
    BullModule.registerQueue({
      name: FEEDBACK_SUMMARY_QUEUE,
      configKey: QUEUE_PRODUCER_CONFIG,
    }),
    BullModule.registerQueue({
      name: FEEDBACK_MAINTENANCE_QUEUE,
      configKey: QUEUE_PRODUCER_CONFIG,
    }),
    BullModule.registerQueue({
      name: REFERENCE_QUEUE,
      configKey: QUEUE_PRODUCER_CONFIG,
    }),
  ],
  providers: [QueueHealthService, QueueLifecycleService],
  exports: [BullModule, QueueHealthService],
})
export class QueueModule {}

@Module({
  imports: [
    BullModule.forRootAsync(QUEUE_WORKER_CONFIG, {
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService<Environment, true>) =>
        createQueueWorkerOptions(config.get("REDIS_URL", { infer: true })),
    }),
    BullModule.registerQueue({
      name: ASSISTANT_QUEUE,
      configKey: QUEUE_WORKER_CONFIG,
    }),
    BullModule.registerQueue({
      name: EMAIL_QUEUE,
      configKey: QUEUE_WORKER_CONFIG,
    }),
    BullModule.registerQueue({
      name: FEEDBACK_QUEUE,
      configKey: QUEUE_WORKER_CONFIG,
    }),
    BullModule.registerQueue({
      name: FEEDBACK_INGRESS_QUEUE,
      configKey: QUEUE_WORKER_CONFIG,
    }),
    BullModule.registerQueue({
      name: FEEDBACK_CONVERSATION_QUEUE,
      configKey: QUEUE_WORKER_CONFIG,
    }),
    BullModule.registerQueue({
      name: FEEDBACK_SUMMARY_QUEUE,
      configKey: QUEUE_WORKER_CONFIG,
    }),
    BullModule.registerQueue({
      name: FEEDBACK_MAINTENANCE_QUEUE,
      configKey: QUEUE_WORKER_CONFIG,
    }),
    BullModule.registerQueue({
      name: REFERENCE_QUEUE,
      configKey: QUEUE_WORKER_CONFIG,
    }),
  ],
  providers: [QueueLifecycleService],
  exports: [BullModule],
})
export class QueueWorkerModule {}
