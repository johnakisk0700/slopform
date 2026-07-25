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
  REFERENCE_QUEUE,
} from "./queue.constants.js";
import { QueueHealthService } from "./queue-health.service.js";
import {
  redisProducerConnectionFromUrl,
  redisWorkerConnectionFromUrl,
} from "./redis-connection.js";

export function createQueueProducerOptions(
  redisUrl: string,
): BullRootModuleOptions {
  return {
    connection: redisProducerConnectionFromUrl(redisUrl),
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: "exponential", delay: 1_000, jitter: 0.5 },
      removeOnComplete: { age: 86_400, count: 1_000 },
      removeOnFail: { age: 604_800, count: 5_000 },
      stackTraceLimit: 10,
    },
    prefix: QUEUE_PREFIX,
  };
}

export function createQueueWorkerOptions(
  redisUrl: string,
): BullRootModuleOptions {
  return {
    connection: redisWorkerConnectionFromUrl(redisUrl),
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
      name: REFERENCE_QUEUE,
      configKey: QUEUE_PRODUCER_CONFIG,
    }),
  ],
  providers: [QueueHealthService],
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
      name: REFERENCE_QUEUE,
      configKey: QUEUE_WORKER_CONFIG,
    }),
  ],
  exports: [BullModule],
})
export class QueueWorkerModule {}
