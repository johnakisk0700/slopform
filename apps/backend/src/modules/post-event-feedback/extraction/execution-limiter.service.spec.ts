import { describe, expect, it, vi } from "vitest";

import {
  RedisFeedbackConversationExecutionLimiter,
  type FeedbackExecutionRedisClient,
} from "./execution-limiter.service.js";

describe("RedisFeedbackConversationExecutionLimiter", () => {
  it("serializes one conversation across workers but not different people", async () => {
    const redis = new SharedLockRedisFake();
    const workerA = new RedisFeedbackConversationExecutionLimiter(
      redis,
      60_000,
      1,
    );
    const workerB = new RedisFeedbackConversationExecutionLimiter(
      redis,
      60_000,
      1,
    );
    const releases: Array<() => void> = [];
    const started: string[] = [];
    const run = (
      worker: RedisFeedbackConversationExecutionLimiter,
      conversationId: string,
      label: string,
    ) =>
      worker.run(conversationId, async () => {
        started.push(label);
        await new Promise<void>((resolve) => releases.push(resolve));
      });

    const first = run(workerA, "conversation-a", "a1");
    const sameConversation = run(workerB, "conversation-a", "a2");
    const otherConversation = run(workerB, "conversation-b", "b1");

    await vi.waitFor(() => expect(started).toEqual(["a1", "b1"]));
    releases.shift()?.();
    await vi.waitFor(() => expect(started).toContain("a2"));
    releases.splice(0).forEach((release) => release());

    await expect(
      Promise.all([first, sameConversation, otherConversation]),
    ).resolves.toEqual([undefined, undefined, undefined]);
  });
});

class SharedLockRedisFake implements FeedbackExecutionRedisClient {
  private readonly locks = new Map<string, string>();

  async set(
    key: string,
    value: string,
    _millisecondsMode: "PX",
    _milliseconds: number,
    _condition: "NX",
  ): Promise<"OK" | null> {
    if (this.locks.has(key)) {
      return null;
    }
    this.locks.set(key, value);
    return "OK";
  }

  async eval(
    _script: string,
    _numberOfKeys: number,
    key: string,
    token: string,
  ): Promise<unknown> {
    if (this.locks.get(key) === token) {
      this.locks.delete(key);
      return 1;
    }
    return 0;
  }

  disconnect(): void {}
}
