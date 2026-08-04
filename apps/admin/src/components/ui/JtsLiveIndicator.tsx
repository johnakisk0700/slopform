import { clsx } from "clsx";
import { RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { resolveLiveIndicatorPainted } from "../../lib/liveIndicator";

export interface JtsLiveIndicatorProps {
  /** True while the pane's query is fetching. Drives the rotation only. */
  active: boolean;
  /**
   * The always-present, visually hidden sentence that states the pane keeps
   * itself current. Written once for assistive technology rather than
   * announced on every tick.
   */
  label: string;
  className?: string;
}

/**
 * A quiet "this pane refreshes itself" mark for a polled surface.
 *
 * A screen that reloads behind the operator's back should say so. This is the
 * whole affordance: a 14px muted stroke icon that turns while a fetch is in
 * flight and fades out when it is not. It always occupies its space, so a poll
 * never nudges the header beside it, and it never pulses, glows or changes
 * colour — status here is "working", not a state anyone must act on.
 *
 * Callers pass `isFetching` as `active`. Temporal hysteresis in
 * `resolveLiveIndicatorPainted` swallows snappy background polls and holds a
 * brief minimum once the icon has appeared, so a 50 ms refetch does not flash.
 *
 * Accessibility is deliberately not a live region. Announcing every three-second
 * poll would be noise; the hidden `label` states the behaviour once and the
 * rotation is decorative reinforcement for sighted operators. `globals.css`
 * collapses the animation under `prefers-reduced-motion`, leaving the icon
 * legible and still.
 */
export function JtsLiveIndicator({
  active,
  label,
  className,
}: JtsLiveIndicatorProps) {
  const [painted, setPainted] = useState(false);
  const becameActiveAtRef = useRef<number | null>(null);
  const shownAtRef = useRef<number | null>(null);

  useEffect(() => {
    const now = Date.now();
    if (active) {
      if (becameActiveAtRef.current === null) {
        becameActiveAtRef.current = now;
      }
    } else {
      becameActiveAtRef.current = null;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;

    function tick() {
      const at = Date.now();
      const next = resolveLiveIndicatorPainted({
        painted,
        active,
        now: at,
        becameActiveAt: becameActiveAtRef.current,
        shownAt: shownAtRef.current,
      });

      if (next.painted !== painted) {
        if (next.painted) {
          shownAtRef.current = at;
        } else {
          shownAtRef.current = null;
        }
        setPainted(next.painted);
        return;
      }

      if (next.checkAfterMs !== null) {
        timer = setTimeout(tick, next.checkAfterMs);
      }
    }

    tick();

    return () => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    };
  }, [active, painted]);

  return (
    <span className={clsx("inline-flex shrink-0 items-center", className)}>
      <RefreshCw
        aria-hidden="true"
        className={clsx(
          "size-3.5 text-ink-subtle transition-opacity duration-300",
          painted ? "animate-spin opacity-100" : "opacity-0",
        )}
      />
      <span className="sr-only">{label}</span>
    </span>
  );
}
