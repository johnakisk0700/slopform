import { Redis } from "ioredis";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ProviderCallLimiter,
  RedisProviderCallLimiter,
  type ProviderCallRedisClient,
} from "./provider-call-limiter.js";

describe("ProviderCallLimiter", () => {
  it("never runs more than the configured number of calls", async () => {
    const limiter = new ProviderCallLimiter(2);
    let active = 0;
    let peak = 0;
    const releases: Array<() => void> = [];

    const calls = Array.from({ length: 5 }, (_, index) =>
      limiter.run(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active -= 1;
        return index;
      }),
    );

    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases.shift()?.();
    releases.shift()?.();
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases.shift()?.();
    releases.shift()?.();
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    releases.shift()?.();

    await expect(Promise.all(calls)).resolves.toEqual([0, 1, 2, 3, 4]);
    expect(peak).toBe(2);
  });

  it("releases a slot when a provider call rejects", async () => {
    const limiter = new ProviderCallLimiter(1);

    await expect(
      limiter.run(async () => {
        throw new Error("provider failed");
      }),
    ).rejects.toThrow("provider failed");

    await expect(limiter.run(async () => "next")).resolves.toBe("next");
  });
});

describe("RedisProviderCallLimiter transport failures", () => {
  const redis = {
    eval: vi.fn<ProviderCallRedisClient["eval"]>(),
    zrem: vi.fn<ProviderCallRedisClient["zrem"]>(),
    disconnect: vi.fn(),
  } satisfies ProviderCallRedisClient;

  beforeEach(() => vi.resetAllMocks());

  it("does not call the provider when Redis acquisition fails", async () => {
    redis.eval.mockRejectedValue(new Error("Redis unavailable"));
    const call = vi.fn();

    await expect(new RedisProviderCallLimiter(redis).run(call)).rejects.toThrow(
      "Redis unavailable",
    );
    expect(call).not.toHaveBeenCalled();
    expect(redis.zrem).not.toHaveBeenCalled();
  });
});

const testRedisUrl = process.env.PROVIDER_LIMITER_TEST_REDIS_URL;

// Opt in to real Lua execution; each test owns a unique Redis key prefix.
describe.skipIf(!testRedisUrl)("RedisProviderCallLimiter with Redis", () => {
  const slotsKey = "jts:ai:provider-call-slots:v1";
  let redis: Redis;
  let otherRedis: Redis;

  beforeEach(async () => {
    const options = {
      keyPrefix: `test:provider-limiter:${randomUUID()}:`,
      lazyConnect: true,
      retryStrategy: () => null,
      connectTimeout: 1_000,
      commandTimeout: 1_000,
    };
    redis = new Redis(testRedisUrl!, options);
    otherRedis = new Redis(testRedisUrl!, options);
    await Promise.all([redis.connect(), otherRedis.connect()]);
  });

  afterEach(async () => {
    try {
      if (redis.status === "ready") await redis.del(slotsKey);
    } finally {
      redis.disconnect();
      otherRedis.disconnect();
    }
  });

  it("shares concurrency across workers without a per-minute start limit", async () => {
    const workers = [
      new RedisProviderCallLimiter(redis, 2, 60_000, 5),
      new RedisProviderCallLimiter(otherRedis, 2, 60_000, 5),
    ];
    let active = 0;
    let peak = 0;
    const calls = Array.from({ length: 80 }, (_, index) =>
      workers[index % 2]!.run(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await delay(5);
        active -= 1;
        return index;
      }),
    );

    expect(await Promise.all(calls)).toEqual(
      Array.from({ length: 80 }, (_, index) => index),
    );
    expect(peak).toBe(2);
    expect(await redis.exists(slotsKey)).toBe(0);
  });

  it("removes expired leases while keeping other workers' active slots", async () => {
    await redis.zadd(slotsKey, 0, "expired", Number.MAX_SAFE_INTEGER, "active");
    const limiter = new RedisProviderCallLimiter(redis, 2, 60_000, 5);

    await limiter.run(async () => {
      expect(await redis.zcard(slotsKey)).toBe(2);
      expect(await redis.zscore(slotsKey, "expired")).toBeNull();
      expect(await redis.pttl(slotsKey)).toBeGreaterThan(0);
      expect(await redis.pttl(slotsKey)).toBeLessThanOrEqual(60_000);
    });

    expect(await redis.zrange(slotsKey, 0, -1)).toEqual(["active"]);
  });

  it("releases a slot after a rejected provider call", async () => {
    const limiter = new RedisProviderCallLimiter(redis, 1);
    await expect(
      limiter.run(async () => {
        throw new Error("provider failed");
      }),
    ).rejects.toThrow("provider failed");

    expect(await redis.exists(slotsKey)).toBe(0);
    await expect(limiter.run(async () => "next")).resolves.toBe("next");
  });
});
