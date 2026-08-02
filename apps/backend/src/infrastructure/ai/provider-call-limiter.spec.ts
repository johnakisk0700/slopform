import { describe, expect, it, vi } from "vitest";

import {
  PROVIDER_CALL_CONCURRENCY_LIMIT,
  ProviderCallLimiter,
} from "./provider-call-limiter.js";

describe("ProviderCallLimiter", () => {
  it("keeps the hardcoded default at five", () => {
    expect(PROVIDER_CALL_CONCURRENCY_LIMIT).toBe(5);
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
});
