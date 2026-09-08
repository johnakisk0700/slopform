import { describe, expect, it } from "vitest";

import {
  LIVE_INDICATOR_MIN_VISIBLE_MS,
  LIVE_INDICATOR_SHOW_DELAY_MS,
  resolveLiveIndicatorPainted,
} from "../src/lib/liveIndicator";

describe("live indicator hysteresis", () => {
  it("ignores fetches that settle before the show delay", () => {
    expect(
      resolveLiveIndicatorPainted({
        painted: false,
        active: true,
        now: 1_000,
        becameActiveAt: 900,
        shownAt: null,
      }),
    ).toEqual({ painted: false, checkAfterMs: 200 });

    expect(
      resolveLiveIndicatorPainted({
        painted: false,
        active: false,
        now: 1_101,
        becameActiveAt: 900,
        shownAt: null,
      }),
    ).toEqual({ painted: false, checkAfterMs: null });
  });

  it("paints after the delay and holds the icon long enough to read", () => {
    expect(
      resolveLiveIndicatorPainted({
        painted: false,
        active: true,
        now: 1_000 + LIVE_INDICATOR_SHOW_DELAY_MS,
        becameActiveAt: 1_000,
        shownAt: null,
      }),
    ).toEqual({ painted: true, checkAfterMs: null });

    expect(
      resolveLiveIndicatorPainted({
        painted: true,
        active: false,
        now: 1_000 + LIVE_INDICATOR_MIN_VISIBLE_MS - 1,
        becameActiveAt: null,
        shownAt: 1_000,
      }),
    ).toEqual({ painted: true, checkAfterMs: 1 });
  });

  it("hides after the minimum hold and stays painted during a new fetch", () => {
    expect(
      resolveLiveIndicatorPainted({
        painted: true,
        active: false,
        now: 1_000 + LIVE_INDICATOR_MIN_VISIBLE_MS,
        becameActiveAt: null,
        shownAt: 1_000,
      }),
    ).toEqual({ painted: false, checkAfterMs: null });

    expect(
      resolveLiveIndicatorPainted({
        painted: true,
        active: true,
        now: 1_100,
        becameActiveAt: 1_000,
        shownAt: 1_000,
      }),
    ).toEqual({ painted: true, checkAfterMs: null });
  });
});
