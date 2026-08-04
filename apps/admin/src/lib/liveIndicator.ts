/**
 * Temporal hysteresis for `JtsLiveIndicator`.
 *
 * Callers still pass TanStack Query's `isFetching` straight through. Snappy
 * background polls (often under 100 ms on a warm local API) must not flash the
 * icon on and off — show only after the fetch has lingered, and once shown
 * keep it long enough that the fade-out is readable.
 */

/** Ignore fetches that settle before this many milliseconds. */
export const LIVE_INDICATOR_SHOW_DELAY_MS = 300;

/** Once painted, stay visible at least this long before fading out. */
export const LIVE_INDICATOR_MIN_VISIBLE_MS = 450;

export interface LiveIndicatorPaintInput {
  /** Whether the icon is currently painted (opacity-100). */
  painted: boolean;
  /** Whether a fetch is in flight right now. */
  active: boolean;
  /** Clock for the decision, milliseconds since epoch. */
  now: number;
  /**
   * When `active` last became true and is still true; `null` while inactive.
   * The component owns this clock so short flaps restart the show delay.
   */
  becameActiveAt: number | null;
  /** When the icon was last painted; `null` while hidden. */
  shownAt: number | null;
}

export interface LiveIndicatorPaintResult {
  painted: boolean;
  /**
   * Milliseconds until the decision may change again, or `null` when nothing
   * is scheduled (steady state).
   */
  checkAfterMs: number | null;
}

/**
 * Pure next-paint decision for the live indicator.
 *
 * The component drives timers from `checkAfterMs`; this function never waits.
 */
export function resolveLiveIndicatorPainted(
  input: LiveIndicatorPaintInput,
): LiveIndicatorPaintResult {
  const { painted, active, now, becameActiveAt, shownAt } = input;

  if (active) {
    if (painted) {
      return { painted: true, checkAfterMs: null };
    }
    const since = becameActiveAt ?? now;
    const remaining = LIVE_INDICATOR_SHOW_DELAY_MS - (now - since);
    if (remaining <= 0) {
      return { painted: true, checkAfterMs: null };
    }
    return { painted: false, checkAfterMs: remaining };
  }

  if (!painted) {
    return { painted: false, checkAfterMs: null };
  }

  const shown = shownAt ?? now;
  const remaining = LIVE_INDICATOR_MIN_VISIBLE_MS - (now - shown);
  if (remaining <= 0) {
    return { painted: false, checkAfterMs: null };
  }
  return { painted: true, checkAfterMs: remaining };
}
