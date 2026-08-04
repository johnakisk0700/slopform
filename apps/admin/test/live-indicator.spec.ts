import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

/**
 * Temporal hysteresis for the shared polling mark. The pure planner lives in
 * `src/lib/liveIndicator.ts` (no React), so vitest can exercise it directly;
 * the component is checked for wiring and a11y invariants via source.
 */

interface LiveIndicatorModule {
  LIVE_INDICATOR_SHOW_DELAY_MS: number;
  LIVE_INDICATOR_MIN_VISIBLE_MS: number;
  resolveLiveIndicatorPainted: (input: {
    painted: boolean;
    active: boolean;
    now: number;
    becameActiveAt: number | null;
    shownAt: number | null;
  }) => { painted: boolean; checkAfterMs: number | null };
}

let live: LiveIndicatorModule;

function readSource(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../${relativePath}`, import.meta.url)),
    "utf8",
  );
}

beforeAll(async () => {
  const moduleUrl = new URL("../src/lib/liveIndicator.ts", import.meta.url).href;
  live = (await import(moduleUrl)) as LiveIndicatorModule;
});

describe("live indicator hysteresis", () => {
  const t0 = 1_000_000;

  it("ignores fetches that settle before the show delay", () => {
    expect(
      live.resolveLiveIndicatorPainted({
        painted: false,
        active: true,
        now: t0,
        becameActiveAt: t0,
        shownAt: null,
      }),
    ).toEqual({
      painted: false,
      checkAfterMs: live.LIVE_INDICATOR_SHOW_DELAY_MS,
    });

    expect(
      live.resolveLiveIndicatorPainted({
        painted: false,
        active: false,
        now: t0 + 50,
        becameActiveAt: null,
        shownAt: null,
      }),
    ).toEqual({ painted: false, checkAfterMs: null });
  });

  it("paints once the show delay has elapsed while still fetching", () => {
    expect(
      live.resolveLiveIndicatorPainted({
        painted: false,
        active: true,
        now: t0 + live.LIVE_INDICATOR_SHOW_DELAY_MS,
        becameActiveAt: t0,
        shownAt: null,
      }),
    ).toEqual({ painted: true, checkAfterMs: null });
  });

  it("holds the painted state for a minimum once shown", () => {
    const shownAt = t0;
    expect(
      live.resolveLiveIndicatorPainted({
        painted: true,
        active: false,
        now: shownAt + 100,
        becameActiveAt: null,
        shownAt,
      }),
    ).toEqual({
      painted: true,
      checkAfterMs: live.LIVE_INDICATOR_MIN_VISIBLE_MS - 100,
    });

    expect(
      live.resolveLiveIndicatorPainted({
        painted: true,
        active: false,
        now: shownAt + live.LIVE_INDICATOR_MIN_VISIBLE_MS,
        becameActiveAt: null,
        shownAt,
      }),
    ).toEqual({ painted: false, checkAfterMs: null });
  });

  it("stays painted when a new fetch arrives during the minimum hold", () => {
    expect(
      live.resolveLiveIndicatorPainted({
        painted: true,
        active: true,
        now: t0 + 100,
        becameActiveAt: t0 + 50,
        shownAt: t0,
      }),
    ).toEqual({ painted: true, checkAfterMs: null });
  });

  it("uses delays long enough to matter and short enough not to lag", () => {
    expect(live.LIVE_INDICATOR_SHOW_DELAY_MS).toBeGreaterThanOrEqual(250);
    expect(live.LIVE_INDICATOR_SHOW_DELAY_MS).toBeLessThanOrEqual(350);
    expect(live.LIVE_INDICATOR_MIN_VISIBLE_MS).toBeGreaterThanOrEqual(400);
    expect(live.LIVE_INDICATOR_MIN_VISIBLE_MS).toBeLessThanOrEqual(550);
  });

  it("wires the planner into the shared indicator with a fade duration", () => {
    const indicator = readSource("src/components/ui/JtsLiveIndicator.tsx");
    expect(indicator).toContain("resolveLiveIndicatorPainted");
    expect(indicator).toContain("duration-300");
    expect(indicator).not.toContain("aria-live");
    expect(indicator).not.toContain('role="status"');
  });
});
