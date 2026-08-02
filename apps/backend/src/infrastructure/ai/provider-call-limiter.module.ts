import { Global, Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { Redis } from "ioredis";

import type { Environment } from "../config/environment.js";
import { redisConnectionFromUrl } from "../queue/redis-connection.js";
import {
  ProviderCallLimiter,
  RedisProviderCallLimiter,
} from "./provider-call-limiter.js";

/** One Redis-backed provider-call budget shared by every worker domain. */
@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: ProviderCallLimiter,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Environment, true>) => {
        const redis = new Redis({
          ...redisConnectionFromUrl(config.get("REDIS_URL", { infer: true })),
          maxRetriesPerRequest: 1,
          lazyConnect: true,
        });
        // Commands still reject and fail the paid call closed. This listener
        // only prevents ioredis from turning a background socket event into an
        // unhandled process-level error.
        redis.on("error", () => undefined);
        return new RedisProviderCallLimiter(redis);
      },
    },
  ],
  exports: [ProviderCallLimiter],
})
export class ProviderCallLimiterModule {}
