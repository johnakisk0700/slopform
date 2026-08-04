import type { ReactNode } from "react";

import { JtsBackLink } from "./JtsBackLink";

export interface JtsPageHeaderProps {
  /** The way out of a detail screen, rendered above the eyebrow. */
  back?: { to: string; label: string };
  /** Tracked wine micro-caps kicker, rendered above the title. */
  eyebrow?: string;
  /** The page's single h1. */
  title: string;
  /** Muted supporting sentence under the title marker. */
  description?: string;
  /** Optional actions (buttons, links) rendered top-right of the header. */
  actions?: ReactNode;
}

/**
 * The page header: an optional back link, an eyebrow, the h1 with its six-dot
 * mark, a muted description and an optional actions row. One per page.
 *
 * The back link lives here rather than in each route because its position is
 * the part screens kept disagreeing on — above the title on two, inside the
 * actions row on a third. Ordering is the header's business; where a route
 * goes is the route's.
 *
 * Actions sit top-right of the header row so a Refresh / primary control stays
 * where operators reach for it, without competing with the title stack.
 */
export function JtsPageHeader({
  back,
  eyebrow,
  title,
  description,
  actions,
}: JtsPageHeaderProps) {
  return (
    <header className="flex w-full max-w-[58rem] items-start justify-between gap-4">
      <div className="flex min-w-0 flex-1 flex-col items-start">
        {back ? (
          <div className="mb-2">
            <JtsBackLink to={back.to}>{back.label}</JtsBackLink>
          </div>
        ) : null}
        {eyebrow ? (
          <p className="mb-1.5 jts-overline text-primary">{eyebrow}</p>
        ) : null}
        {/* Fixed 1.375rem, not a viewport clamp: an operations panel is read at
            one working size all day, and a title that grew to 2.6rem on a wide
            monitor spent the height the actual work needs. The base layer's
            --jts-tracking-tight already applies; no utility overrides it. */}
        <h1 className="jts-title-mark mb-2 font-display text-[1.375rem] font-extrabold">
          {title}
        </h1>
        {description ? (
          <p className="mb-0 max-w-[65ch] text-sm text-ink-muted">
            {description}
          </p>
        ) : null}
      </div>
      {actions ? (
        <div className="mt-0 flex shrink-0 flex-wrap items-start justify-end gap-3">
          {actions}
        </div>
      ) : null}
    </header>
  );
}
