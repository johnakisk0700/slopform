import type { Queue } from "bullmq";
import { afterEach, describe, expect, it, vi } from "vitest";

import { QueueHealthService } from "./queue-health.service.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("QueueHealthService", () => {
  it("bounds and coalesces readiness checks while Redis is unavailable", async () => {
    vi.useFakeTimers();
    const queue = {
      getJobCounts: vi.fn().mockReturnValue(new Promise(() => undefined)),
      on: vi.fn(),
    } as unknown as Queue;
    const health = new QueueHealthService(queue);

    const first = health.ping();
    const second = health.ping();
    const assertions = Promise.all([
      expect(first).rejects.toThrow("timed out after 1000ms"),
      expect(second).rejects.toThrow("timed out after 1000ms"),
    ]);
    await vi.advanceTimersByTimeAsync(1_000);
    await assertions;

    expect(queue.getJobCounts).toHaveBeenCalledOnce();
  });
});
