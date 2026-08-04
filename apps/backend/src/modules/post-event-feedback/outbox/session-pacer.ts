import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Redis } from "ioredis";

import type { Environment } from "../../../infrastructure/config/environment.js";
import { redisConnectionFromUrl } from "../../../infrastructure/queue/redis-connection.js";

/** Deployment-wide Wasender pacing owned by the direct dispatcher. */
export const FEEDBACK_SEND_MIN_INTERVAL_MS = 1_500;
export const FEEDBACK_SEND_JITTER_MS = 500;

/** Injection token for the dispatcher-wide pacing boundary. */
export const FEEDBACK_SEND_LIMITER = Symbol(
  "join-the-six.feedback-send-limiter",
);

export interface FeedbackSendLimiter {
  waitTurn(): Promise<{ readonly waitedMs: number }>;
}

const FEEDBACK_SEND_SLOT_REDIS_KEY = "jts:feedback:wasender-send-slots:v2";
const FEEDBACK_SEND_SLOT_TTL_MARGIN_MS = 60_000;

/**
 * Grants a provider start slot using Redis's clock.
 *
 * The value is the earliest time a caller may win the next slot. A caller that
 * arrives early is told how long to wait and must compete again after waking;
 * Redis only advances the boundary for the caller that wins at that point.
 * Re-checking matters because a suspended waiter may wake after a later caller:
 * pre-allocating both future slots would let the late process send beside the
 * newer one. A crash after a grant can waste one interval but cannot reserve an
 * unbounded chain of future capacity.
 */
const RESERVE_FEEDBACK_SEND_SLOT_SCRIPT = `
local nowParts = redis.call("TIME")
local now = (tonumber(nowParts[1]) * 1000) + math.floor(tonumber(nowParts[2]) / 1000)
local nextAt = tonumber(redis.call("GET", KEYS[1])) or 0
if nextAt > now then
  return nextAt - now
end

local followingAt = now + tonumber(ARGV[1]) + tonumber(ARGV[2])
local ttl = followingAt - now + tonumber(ARGV[3])
redis.call("SET", KEYS[1], followingAt, "PX", ttl)
return 0
`;

export interface FeedbackSendLimiterRedisClient {
  eval(
    script: string,
    numberOfKeys: number,
    ...args: Array<string | number>
  ): Promise<unknown>;
  disconnect(): void;
}

export type RedisFeedbackSendLimiterOptions = {
  readonly minIntervalMs?: number;
  readonly jitterMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
};

/**
 * Deployment-wide limiter for this backend's Wasender callers.
 *
 * Redis failure is fail-closed: `waitTurn` rejects and the dispatcher leaves
 * the row in its safely reclaimable `claimed` state. The dedicated Redis
 * client is owned by this provider and disconnected with the Nest module.
 * WordPress uses the same Wasender session but not this Redis key, so this is
 * deliberately not advertised as a session-wide provider quota.
 */
export class RedisFeedbackSendLimiter
  implements FeedbackSendLimiter, OnModuleDestroy
{
  private readonly minIntervalMs: number;
  private readonly jitterMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  constructor(
    private readonly redis: FeedbackSendLimiterRedisClient,
    options: RedisFeedbackSendLimiterOptions = {},
  ) {
    this.minIntervalMs = options.minIntervalMs ?? FEEDBACK_SEND_MIN_INTERVAL_MS;
    this.jitterMs = options.jitterMs ?? FEEDBACK_SEND_JITTER_MS;
    this.sleep =
      options.sleep ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = options.random ?? Math.random;

    if (!Number.isInteger(this.minIntervalMs) || this.minIntervalMs < 1) {
      throw new Error("Feedback send interval must be a positive integer");
    }
    if (!Number.isInteger(this.jitterMs) || this.jitterMs < 0) {
      throw new Error("Feedback send jitter must be a non-negative integer");
    }
  }

  async waitTurn(): Promise<{ readonly waitedMs: number }> {
    const jitter =
      this.jitterMs === 0 ? 0 : Math.floor(this.random() * (this.jitterMs + 1));
    let waitedMs = 0;

    while (true) {
      const rawWait = await this.redis.eval(
        RESERVE_FEEDBACK_SEND_SLOT_SCRIPT,
        1,
        FEEDBACK_SEND_SLOT_REDIS_KEY,
        this.minIntervalMs,
        jitter,
        FEEDBACK_SEND_SLOT_TTL_MARGIN_MS,
      );
      const nextWaitMs = parseReservedWait(rawWait);
      if (nextWaitMs === 0) {
        return { waitedMs };
      }
      waitedMs += nextWaitMs;
      await this.sleep(nextWaitMs);
    }
  }

  onModuleDestroy(): void {
    this.redis.disconnect();
  }
}

/** Ready-to-register Nest provider backed by a dedicated Redis connection. */
@Injectable()
export class FeedbackSendLimiterService extends RedisFeedbackSendLimiter {
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

function parseReservedWait(value: unknown): number {
  const milliseconds = Number(value);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    throw new Error("Redis returned an invalid feedback send slot");
  }
  return milliseconds;
}
