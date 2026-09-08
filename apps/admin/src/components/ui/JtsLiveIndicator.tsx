import { clsx } from "clsx";
import { RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";

const SHOW_DELAY_MS = 300;
const MIN_VISIBLE_MS = 450;

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

// Keep fast polls invisible and hold longer polls briefly, without layout shifts.
export function JtsLiveIndicator({
  active,
  label,
  className,
}: JtsLiveIndicatorProps) {
  const [painted, setPainted] = useState(false);
  const shownAt = useRef(0);

  useEffect(() => {
    if (active === painted) return;

    const delay = active
      ? SHOW_DELAY_MS
      : Math.max(0, MIN_VISIBLE_MS - (Date.now() - shownAt.current));
    const timer = setTimeout(() => {
      if (active) shownAt.current = Date.now();
      setPainted(active);
    }, delay);

    return () => clearTimeout(timer);
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
