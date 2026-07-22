import { BullModule } from "@nestjs/bullmq";
import { Global, Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";

import type { Environment } from "../config/environment.js";
import { REFERENCE_QUEUE } from "./queue.constants.js";
import { QueueHealthService } from "./queue-health.service.js";
import { redisConnectionFromUrl } from "./redis-connection.js";

@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService<Environment, true>) => ({
        connection: redisConnectionFromUrl(
          config.get("REDIS_URL", { infer: true }),
        ),
        defaultJobOptions: {
          attempts: 5,
          backoff: { type: "exponential", delay: 1_000 },
          removeOnComplete: { age: 86_400, count: 1_000 },
          removeOnFail: { age: 604_800, count: 5_000 },
        },
        prefix: "jts",
      }),
    }),
    BullModule.registerQueue({ name: REFERENCE_QUEUE }),
  ],
  providers: [QueueHealthService],
  exports: [BullModule, QueueHealthService],
})
export class QueueModule {}
