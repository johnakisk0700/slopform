import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";

import type { Environment } from "../../../infrastructure/config/environment.js";
import { redisConnectionFromUrl } from "../../../infrastructure/queue/redis-connection.js";

/** Long enough for the bounded provider calls plus validation/persistence. */
export const FEEDBACK_CONVERSATION_EXECUTION_LEASE_MS = 15 * 60_000;
const FEEDBACK_CONVERSATION_LOCK_RETRY_MS = 100;
const FEEDBACK_CONVERSATION_LOCK_PREFIX =
  "jts:feedback:conversation-execution:v1";

const RELEASE_CONVERSATION_LOCK_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;

export interface FeedbackExecutionRedisClient {
  set(
    key: string,
    value: string,
    millisecondsMode: "PX",
    milliseconds: number,
    condition: "NX",
  ): Promise<"OK" | null>;
  eval(
    script: string,
    numberOfKeys: number,
    ...args: string[]
  ): Promise<unknown>;
  disconnect(): void;
}

/**
 * Serializes extraction/fallback for one conversation across worker replicas.
 *
 * BullMQ's worker concurrency can therefore serve different people in parallel
 * without letting two due cursor jobs buy the same model call and race their
 * replies. A dead holder blocks that conversation until the lease expires; it
 * never allows a second holder while the first lease is live.
 */
export class RedisFeedbackConversationExecutionLimiter implements OnModuleDestroy {
  constructor(
    private readonly redis: FeedbackExecutionRedisClient,
    private readonly leaseMs: number = FEEDBACK_CONVERSATION_EXECUTION_LEASE_MS,
    private readonly retryMs: number = FEEDBACK_CONVERSATION_LOCK_RETRY_MS,
  ) {
    if (!Number.isInteger(leaseMs) || leaseMs < 1) {
      throw new Error("Feedback conversation lease must be a positive integer");
    }
    if (!Number.isInteger(retryMs) || retryMs < 1) {
      throw new Error(
        "Feedback conversation retry delay must be a positive integer",
      );
    }
  }

  async run<T>(conversationId: string, work: () => Promise<T>): Promise<T> {
    const key = `${FEEDBACK_CONVERSATION_LOCK_PREFIX}:${conversationId}`;
    const token = randomUUID();
    await this.acquire(key, token);
    try {
      return await work();
    } finally {
      await this.redis.eval(RELEASE_CONVERSATION_LOCK_SCRIPT, 1, key, token);
    }
  }

  onModuleDestroy(): void {
    this.redis.disconnect();
  }

  private async acquire(key: string, token: string): Promise<void> {
    for (;;) {
      const result = await this.redis.set(key, token, "PX", this.leaseMs, "NX");
      if (result === "OK") {
        return;
      }
      await delay(this.retryMs);
    }
  }
}

@Injectable()
export class FeedbackConversationExecutionLimiter extends RedisFeedbackConversationExecutionLimiter {
  constructor(config: ConfigService<Environment, true>) {
    const redis = new Redis({
      ...redisConnectionFromUrl(config.get("REDIS_URL", { infer: true })),
      maxRetriesPerRequest: 1,
      lazyConnect: true,
    });
    redis.on("error", () => undefined);
    super(redis);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
