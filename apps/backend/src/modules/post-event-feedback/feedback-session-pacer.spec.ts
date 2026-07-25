import { describe, expect, it, vi } from "vitest";

import {
  FeedbackSessionPacer,
  FEEDBACK_SEND_JITTER_MS,
  FEEDBACK_SEND_MIN_INTERVAL_MS,
} from "./feedback-session-pacer.js";

describe("FeedbackSessionPacer", () => {
  it("waits at least the minimum interval plus jitter between turns", async () => {
    let now = 1_000;
    const sleeps: number[] = [];
    const pacer = new FeedbackSessionPacer({
      minIntervalMs: FEEDBACK_SEND_MIN_INTERVAL_MS,
      jitterMs: FEEDBACK_SEND_JITTER_MS,
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
      // random() in [0, 1) — 0.999 maps to the inclusive jitter upper bound.
      random: () => 0.999,
    });

    const expectedWait =
      FEEDBACK_SEND_MIN_INTERVAL_MS +
      Math.floor(0.999 * (FEEDBACK_SEND_JITTER_MS + 1));

    await expect(pacer.waitTurn()).resolves.toEqual({ waitedMs: 0 });
    await expect(pacer.waitTurn()).resolves.toEqual({ waitedMs: expectedWait });
    expect(sleeps).toEqual([expectedWait]);
  });

  it("keeps waitedMs within the configured pacing bounds", async () => {
    let now = 0;
    const waited: number[] = [];
    const pacer = new FeedbackSessionPacer({
      minIntervalMs: 100,
      jitterMs: 50,
      now: () => now,
      sleep: async (ms) => {
        waited.push(ms);
        now += ms;
      },
      random: () => 0.4,
    });

    await pacer.waitTurn();
    const second = await pacer.waitTurn();
    expect(second.waitedMs).toBeGreaterThanOrEqual(100);
    expect(second.waitedMs).toBeLessThanOrEqual(150);
    expect(waited[0]).toBe(second.waitedMs);
  });

  it("serializes concurrent waiters so the gap is measured between slots", async () => {
    let now = 0;
    const pacer = new FeedbackSessionPacer({
      minIntervalMs: 100,
      jitterMs: 0,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      random: () => 0,
    });

    const [first, second] = await Promise.all([
      pacer.waitTurn(),
      pacer.waitTurn(),
    ]);
    expect(first.waitedMs).toBe(0);
    expect(second.waitedMs).toBe(100);
  });
});
