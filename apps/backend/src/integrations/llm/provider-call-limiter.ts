import type { OnModuleDestroy } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * Shared concurrency guard across worker replicas, not a provider quota.
 */
export const PROVIDER_CALL_CONCURRENCY_LIMIT = 30;

/** Longer than the longest provider timeout (campaign summaries: five min). */
export const PROVIDER_CALL_LEASE_MS = 6 * 60_000;

const PROVIDER_CALL_RETRY_MS = 1_000;
const PROVIDER_CALL_REDIS_KEY = "jts:ai:provider-call-slots:v1";
const ACQUIRE_PROVIDER_SLOT_SCRIPT = readFileSync(
  new URL("./acquire-provider-slot.lua", import.meta.url),
  "utf8",
);

export interface ProviderCallRedisClient {
  eval(
    script: string,
    numberOfKeys: number,
    ...args: Array<string | number>
  ): Promise<unknown>;
  zrem(key: string, token: string): Promise<number>;
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
 * Deployment-wide concurrency semaphore. Lua atomically claims a slot;
 * finally releases it. Six-minute leases recover capacity after worker death.
 * Acquisition fails closed: no Redis slot means no paid call.
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
  ) {
    super(limit);
    if (!Number.isInteger(leaseMs) || leaseMs < 1) {
      throw new Error("Provider call lease must be a positive integer");
    }
    if (!Number.isInteger(retryMs) || retryMs < 1) {
      throw new Error("Provider call retry delay must be a positive integer");
    }
  }

  override async run<T>(call: () => Promise<T>): Promise<T> {
    const token = randomUUID();
    await this.acquireDistributed(token);
    try {
      return await call();
    } finally {
      await this.redis.zrem(PROVIDER_CALL_REDIS_KEY, token);
    }
  }

  onModuleDestroy(): void {
    this.redis.disconnect();
  }

  private async acquireDistributed(token: string): Promise<void> {
    for (;;) {
      const acquired = await this.redis.eval(
        ACQUIRE_PROVIDER_SLOT_SCRIPT,
        1,
        PROVIDER_CALL_REDIS_KEY,
        this.limit,
        this.leaseMs,
        token,
      );
      if (acquired === 1) {
        return;
      }
      if (acquired !== 0) {
        throw new Error("Redis returned an invalid provider-slot result");
      }
      await delay(this.retryMs);
    }
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
