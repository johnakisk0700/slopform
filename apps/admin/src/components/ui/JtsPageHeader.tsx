import type { ReactNode } from "react";
import { Hash } from "lucide-react";

import { JtsBackLink } from "./JtsBackLink";

export interface JtsPageHeaderProps {
  /** The way out of a detail screen, rendered above the title. */
  back?: { to: string; label: string };
  /** The page's single h1. */
  title: string;
  /** Muted supporting sentence under the title. */
  description?: string;
  /** Optional actions (buttons, links) rendered bottom-right of the header. */
  actions?: ReactNode;
}

/**
 * The page header: an optional back link, the h1, a muted description and an
 * optional actions row. One per page.
 *
 * The back link lives here rather than in each route because its position is
 * the part screens kept disagreeing on — above the title on two, inside the
 * actions row on a third. Ordering is the header's business; where a route
 * goes is the route's.
 *
 * Actions sit bottom-right of the full header row — trailing edge of the page
 * content, baseline with the description — so a Refresh / primary control stays
 * where operators reach for it without competing with the title stack or
 * floating mid-column under a reading-width cap.
 */
export function JtsPageHeader({
  back,
  title,
  description,
  actions,
}: JtsPageHeaderProps) {
  return (
    <header className="flex w-full items-end justify-between gap-4">
      <div className="flex min-w-0 flex-1 flex-col items-start">
        {back ? (
          <div className="mb-2">
            <JtsBackLink to={back.to}>{back.label}</JtsBackLink>
          </div>
        ) : null}
        {/* Fixed 1.375rem, not a viewport clamp: an operations panel is read at
            one working size all day, and a title that grew to 2.6rem on a wide
            monitor spent the height the actual work needs. The base layer's
            --jts-tracking-tight already applies; no utility overrides it. */}
        <h1 className="jts-page-title mb-2 font-display text-[1.375rem] font-bold lg:-ms-6">
          <Hash aria-hidden="true" className="jts-page-title-mark" />
          {title}
        </h1>
        {description ? (
          <p className="mb-0 max-w-[65ch] text-sm text-ink-muted">
            {description}
          </p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-3">
          {actions}
        </div>
      ) : null}
    </header>
  );
}
