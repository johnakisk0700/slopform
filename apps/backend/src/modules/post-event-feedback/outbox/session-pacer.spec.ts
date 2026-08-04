import { describe, expect, it, vi } from "vitest";

import {
  RedisFeedbackSendLimiter,
  type FeedbackSendLimiterRedisClient,
} from "./session-pacer.js";

describe("RedisFeedbackSendLimiter", () => {
  it("shares one ordered start timeline across limiter instances", async () => {
    const redis = new FakeSendLimiterRedis();
    const sleepsA: number[] = [];
    const sleepsB: number[] = [];
    const limiterA = new RedisFeedbackSendLimiter(redis, {
      minIntervalMs: 100,
      jitterMs: 0,
      sleep: async (ms) => {
        sleepsA.push(ms);
      },
    });
    const limiterB = new RedisFeedbackSendLimiter(redis, {
      minIntervalMs: 100,
      jitterMs: 0,
      sleep: async (ms) => {
        sleepsB.push(ms);
        redis.advance(ms);
      },
    });

    await expect(limiterA.waitTurn()).resolves.toEqual({ waitedMs: 0 });
    await expect(limiterB.waitTurn()).resolves.toEqual({ waitedMs: 100 });
    expect(sleepsA).toEqual([]);
    expect(sleepsB).toEqual([100]);
  });

  it("makes a late sleeper compete again instead of bunching starts", async () => {
    const redis = new FakeSendLimiterRedis();
    const first = new RedisFeedbackSendLimiter(redis, {
      minIntervalMs: 100,
      jitterMs: 0,
    });
    const sleeps: number[] = [];
    let releaseFirstSleep: (() => void) | undefined;
    const late = new RedisFeedbackSendLimiter(redis, {
      minIntervalMs: 100,
      jitterMs: 0,
      sleep: async (ms) => {
        sleeps.push(ms);
        if (sleeps.length === 1) {
          await new Promise<void>((resolve) => {
            releaseFirstSleep = resolve;
          });
          return;
        }
        redis.advance(ms);
      },
    });
    const newer = new RedisFeedbackSendLimiter(redis, {
      minIntervalMs: 100,
      jitterMs: 0,
    });

    await first.waitTurn();
    const lateTurn = late.waitTurn();
    await vi.waitFor(() => expect(sleeps).toEqual([100]));

    // The original waiter is suspended past its nominal slot. A newer caller
    // wins at Redis time 1_200; the late waiter must not send beside it.
    redis.advance(200);
    await expect(newer.waitTurn()).resolves.toEqual({ waitedMs: 0 });
    releaseFirstSleep?.();

    await expect(lateTurn).resolves.toEqual({ waitedMs: 200 });
    expect(sleeps).toEqual([100, 100]);
    expect(redis.grants).toEqual([1_000, 1_200, 1_300]);
  });

  it("fails closed when Redis cannot reserve a send slot", async () => {
    const redis = {
      eval: vi.fn().mockRejectedValue(new Error("redis unavailable")),
      disconnect: vi.fn(),
    };
    const limiter = new RedisFeedbackSendLimiter(redis, {
      minIntervalMs: 100,
      jitterMs: 0,
    });

    await expect(limiter.waitTurn()).rejects.toThrow("redis unavailable");
  });

  it("owns and disconnects its dedicated Redis client", () => {
    const redis = new FakeSendLimiterRedis();
    const limiter = new RedisFeedbackSendLimiter(redis);

    limiter.onModuleDestroy();

    expect(redis.disconnected).toBe(true);
  });
});

class FakeSendLimiterRedis implements FeedbackSendLimiterRedisClient {
  private nextAt: number | undefined;
  private now = 1_000;
  readonly grants: number[] = [];
  disconnected = false;

  async eval(
    _script: string,
    _numberOfKeys: number,
    ...args: Array<string | number>
  ): Promise<unknown> {
    const minIntervalMs = Number(args[1]);
    const jitterMs = Number(args[2]);
    if (this.nextAt !== undefined && this.nextAt > this.now) {
      return this.nextAt - this.now;
    }
    this.grants.push(this.now);
    this.nextAt = this.now + minIntervalMs + jitterMs;
    return 0;
  }

  advance(milliseconds: number): void {
    this.now += milliseconds;
  }

  disconnect(): void {
    this.disconnected = true;
  }
}
