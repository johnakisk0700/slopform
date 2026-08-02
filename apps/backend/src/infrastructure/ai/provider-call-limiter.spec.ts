import { describe, expect, it, vi } from "vitest";

import {
  PROVIDER_CALL_CONCURRENCY_LIMIT,
  PROVIDER_CALL_STARTS_PER_MINUTE_LIMIT,
  ProviderCallLimiter,
  RedisProviderCallLimiter,
  type ProviderCallRedisClient,
} from "./provider-call-limiter.js";

describe("ProviderCallLimiter", () => {
  it("keeps the deployment-wide hardcoded default at thirty", () => {
    expect(PROVIDER_CALL_CONCURRENCY_LIMIT).toBe(30);
    expect(PROVIDER_CALL_STARTS_PER_MINUTE_LIMIT).toBe(30);
  });

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

  it("shares one ceiling across independent worker limiter instances", async () => {
    const redis = new SharedSemaphoreRedisFake();
    const workerA = new RedisProviderCallLimiter(redis, 2, 60_000, 1);
    const workerB = new RedisProviderCallLimiter(redis, 2, 60_000, 1);
    let active = 0;
    let peak = 0;
    const releases: Array<() => void> = [];

    const calls = Array.from({ length: 6 }, (_, index) =>
      (index % 2 === 0 ? workerA : workerB).run(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active -= 1;
        return index;
      }),
    );

    await vi.waitFor(() => expect(releases).toHaveLength(2));
    for (let completed = 0; completed < calls.length; completed += 1) {
      releases.shift()?.();
      if (completed < calls.length - 2) {
        await vi.waitFor(() => expect(releases.length).toBeGreaterThan(0));
      }
    }

    await expect(Promise.all(calls)).resolves.toEqual([0, 1, 2, 3, 4, 5]);
    expect(peak).toBe(2);
  });

  it("retains completed starts until the rolling rate window clears", async () => {
    const redis = new SharedSemaphoreRedisFake();
    const limiter = new RedisProviderCallLimiter(
      redis,
      5,
      60_000,
      1,
      2,
      60_000,
    );

    await expect(limiter.run(async () => "first")).resolves.toBe("first");
    await expect(limiter.run(async () => "second")).resolves.toBe("second");

    let thirdStarted = false;
    const third = limiter.run(async () => {
      thirdStarted = true;
      return "third";
    });

    await vi.waitFor(() => expect(redis.rateDenials).toBeGreaterThan(0));
    expect(thirdStarted).toBe(false);
    redis.clearRateWindow();

    await expect(third).resolves.toBe("third");
  });
});

class SharedSemaphoreRedisFake implements ProviderCallRedisClient {
  private readonly activeTokens = new Set<string>();
  private readonly recentStarts = new Set<string>();
  rateDenials = 0;

  async eval(
    script: string,
    _numberOfKeys: number,
    ...args: Array<string | number>
  ): Promise<unknown> {
    if (script.includes('redis.call("ZREM"')) {
      const token = String(args.at(-1));
      this.activeTokens.delete(token);
      return 1;
    }

    const token = String(args[4]);
    const limit = Number(args[2]);
    const rateLimit = Number(args[5]);
    if (this.recentStarts.size >= rateLimit) {
      this.rateDenials += 1;
      return [0, 1];
    }
    if (this.activeTokens.size >= limit) {
      return [0, 1];
    }
    this.activeTokens.add(token);
    this.recentStarts.add(token);
    return [1, 0];
  }

  clearRateWindow(): void {
    this.recentStarts.clear();
  }

  disconnect(): void {}
}
