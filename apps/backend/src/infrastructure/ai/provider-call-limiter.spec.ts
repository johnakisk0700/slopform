import { describe, expect, it, vi } from "vitest";

import {
  PROVIDER_CALL_CONCURRENCY_LIMIT,
  ProviderCallLimiter,
  RedisProviderCallLimiter,
  type ProviderCallRedisClient,
} from "./provider-call-limiter.js";

describe("ProviderCallLimiter", () => {
  it("keeps the deployment-wide hardcoded default at twenty", () => {
    expect(PROVIDER_CALL_CONCURRENCY_LIMIT).toBe(20);
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
});

class SharedSemaphoreRedisFake implements ProviderCallRedisClient {
  private readonly activeTokens = new Set<string>();

  async eval(
    script: string,
    _numberOfKeys: number,
    ...args: Array<string | number>
  ): Promise<unknown> {
    const token = String(args.at(-1));
    if (script.includes('redis.call("ZREM"')) {
      this.activeTokens.delete(token);
      return 1;
    }

    const limit = Number(args[1]);
    if (this.activeTokens.size >= limit) {
      return [0, 1];
    }
    this.activeTokens.add(token);
    return [1, 0];
  }

  disconnect(): void {}
}
