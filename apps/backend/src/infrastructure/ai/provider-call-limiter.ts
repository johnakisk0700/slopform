import type { OnModuleDestroy } from "@nestjs/common";
import { randomUUID } from "node:crypto";

/**
 * Maximum paid model requests the whole deployment may keep in flight.
 *
 * OpenAI and OpenRouter enforce account/model-specific RPM and TPM limits, not
 * one public concurrency quota. Thirty is therefore our product guard, not a
 * statement about either provider. Production uses the Redis-backed limiter
 * below, so adding worker replicas does not multiply this ceiling.
 */
export const PROVIDER_CALL_CONCURRENCY_LIMIT = 30;

/**
 * Maximum provider requests allowed to start in any rolling minute.
 *
 * Direct probes on 2026-08-03 measured this project's Terra allowance at 500
 * RPM / 500k TPM. The first production rehearsal peaked at 166,983 reported
 * tokens in a rolling 60-second completion window while limited to 30 starts.
 * Sixty is the next measured operating point: still guarded by the separate
 * 30-call semaphore and expected to remain below the observed TPM allowance,
 * but rehearsal logs — not this arithmetic — decide whether it stays.
 */
export const PROVIDER_CALL_STARTS_PER_MINUTE_LIMIT = 60;
export const PROVIDER_CALL_RATE_WINDOW_MS = 60_000;

/** Longer than the longest provider timeout (campaign summaries: five min). */
export const PROVIDER_CALL_LEASE_MS = 6 * 60_000;

const PROVIDER_CALL_RETRY_MS = 100;
const PROVIDER_CALL_REDIS_KEY = "jts:ai:provider-call-slots:v1";
const PROVIDER_CALL_RATE_REDIS_KEY = "jts:ai:provider-call-starts:v1";

const ACQUIRE_PROVIDER_SLOT_SCRIPT = `
local nowParts = redis.call("TIME")
local now = (tonumber(nowParts[1]) * 1000) + math.floor(tonumber(nowParts[2]) / 1000)
redis.call("ZREMRANGEBYSCORE", KEYS[1], "-inf", now)
redis.call("ZREMRANGEBYSCORE", KEYS[2], "-inf", now - tonumber(ARGV[5]))

if redis.call("ZCARD", KEYS[2]) >= tonumber(ARGV[4]) then
  local earliest = redis.call("ZRANGE", KEYS[2], 0, 0, "WITHSCORES")
  return { 0, math.max(1, tonumber(earliest[2]) + tonumber(ARGV[5]) - now) }
end

if redis.call("ZCARD", KEYS[1]) >= tonumber(ARGV[1]) then
  local earliest = redis.call("ZRANGE", KEYS[1], 0, 0, "WITHSCORES")
  return { 0, math.max(1, tonumber(earliest[2]) - now) }
end

redis.call("ZADD", KEYS[1], now + tonumber(ARGV[2]), ARGV[3])
redis.call("ZADD", KEYS[2], now, ARGV[3])
redis.call("PEXPIRE", KEYS[1], tonumber(ARGV[2]) + 60000)
redis.call("PEXPIRE", KEYS[2], tonumber(ARGV[5]) + 60000)
return { 1, 0 }
`;

const RELEASE_PROVIDER_SLOT_SCRIPT = `
redis.call("ZREM", KEYS[1], ARGV[1])
if redis.call("ZCARD", KEYS[1]) == 0 then
  redis.call("DEL", KEYS[1])
end
return 1
`;

export interface ProviderCallRedisClient {
  eval(
    script: string,
    numberOfKeys: number,
    ...args: Array<string | number>
  ): Promise<unknown>;
  disconnect(): void;
}

type PendingAcquire = () => void;

/** FIFO in-memory semaphore used by focused unit tests and direct callers. */
export class ProviderCallLimiter {
  private active = 0;
  private readonly pending: PendingAcquire[] = [];

  constructor(readonly limit: number = PROVIDER_CALL_CONCURRENCY_LIMIT) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(
        "Provider call concurrency limit must be a positive integer",
      );
    }
  }

  async run<T>(call: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await call();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      this.pending.push(() => {
        this.active += 1;
        resolve();
      });
    });
  }

  private release(): void {
    this.active -= 1;
    const next = this.pending.shift();
    next?.();
  }
}

/**
 * Deployment-wide semaphore and rolling start-rate gate backed by Redis sorted
 * sets.
 *
 * Each member is a random lease token and its score is the expiry according to
 * Redis's clock. Acquisition removes expired leases and claims a slot in one
 * Lua script, so workers cannot race past the cap. A dead process temporarily
 * consumes capacity, never creates extra capacity; its lease expires after the
 * longest bounded provider call plus one minute of margin. Releasing a call
 * removes only its active lease; its start remains in the rolling-minute set so
 * fast calls cannot burst through the token budget.
 *
 * Redis failure is deliberately fail-closed: no slot means no paid call. The
 * queue retry remains the visible recovery mechanism.
 */
export class RedisProviderCallLimiter
  extends ProviderCallLimiter
  implements OnModuleDestroy
{
  constructor(
    private readonly redis: ProviderCallRedisClient,
    limit: number = PROVIDER_CALL_CONCURRENCY_LIMIT,
    private readonly leaseMs: number = PROVIDER_CALL_LEASE_MS,
    private readonly retryMs: number = PROVIDER_CALL_RETRY_MS,
    private readonly rateLimit: number = PROVIDER_CALL_STARTS_PER_MINUTE_LIMIT,
    private readonly rateWindowMs: number = PROVIDER_CALL_RATE_WINDOW_MS,
  ) {
    super(limit);
    if (!Number.isInteger(leaseMs) || leaseMs < 1) {
      throw new Error("Provider call lease must be a positive integer");
    }
    if (!Number.isInteger(retryMs) || retryMs < 1) {
      throw new Error("Provider call retry delay must be a positive integer");
    }
    if (!Number.isInteger(rateLimit) || rateLimit < 1) {
      throw new Error("Provider call rate limit must be a positive integer");
    }
    if (!Number.isInteger(rateWindowMs) || rateWindowMs < 1) {
      throw new Error("Provider call rate window must be a positive integer");
    }
  }

  override async run<T>(call: () => Promise<T>): Promise<T> {
    const token = randomUUID();
    await this.acquireDistributed(token);
    try {
      return await call();
    } finally {
      await this.redis.eval(
        RELEASE_PROVIDER_SLOT_SCRIPT,
        1,
        PROVIDER_CALL_REDIS_KEY,
        token,
      );
    }
  }

  onModuleDestroy(): void {
    this.redis.disconnect();
  }

  private async acquireDistributed(token: string): Promise<void> {
    for (;;) {
      const raw = await this.redis.eval(
        ACQUIRE_PROVIDER_SLOT_SCRIPT,
        2,
        PROVIDER_CALL_REDIS_KEY,
        PROVIDER_CALL_RATE_REDIS_KEY,
        this.limit,
        this.leaseMs,
        token,
        this.rateLimit,
        this.rateWindowMs,
      );
      const [acquired, waitMs] = parseAcquireResult(raw);
      if (acquired === 1) {
        return;
      }
      await delay(Math.min(this.retryMs, waitMs));
    }
  }
}

function parseAcquireResult(value: unknown): readonly [number, number] {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    ![0, 1].includes(Number(value[0])) ||
    !Number.isFinite(Number(value[1])) ||
    Number(value[1]) < 0
  ) {
    throw new Error("Redis returned an invalid provider-slot result");
  }
  return [Number(value[0]), Number(value[1])];
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
