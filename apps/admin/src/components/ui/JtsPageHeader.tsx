import type { ReactNode } from "react";

export interface JtsPageHeaderProps {
  /** Tracked wine micro-caps kicker, rendered above the title. */
  eyebrow?: string;
  /** The page's single h1. */
  title: string;
  /** Muted supporting sentence under the title marker. */
  description?: string;
  /** Optional actions (buttons, links) rendered below the copy. */
  actions?: ReactNode;
}

/**
 * The page header: eyebrow, h1 with the signature horizontal marker,
 * a muted description and an optional actions row. One per page.
 */
export function JtsPageHeader({
  eyebrow,
  title,
  description,
  actions,
}: JtsPageHeaderProps) {
  return (
    <header className="flex items-end justify-between gap-6">
      <div className="max-w-[58rem]">
        {eyebrow ? (
          <p className="mb-1.5 jts-overline text-primary">{eyebrow}</p>
        ) : null}
        {/* Fixed 1.375rem, not a viewport clamp: an operations panel is read at
            one working size all day, and a title that grew to 2.6rem on a wide
            monitor spent the height the actual work needs. The base layer's
            --jts-tracking-tight already applies; no utility overrides it. */}
        <h1 className="mb-2 font-display text-[1.375rem] font-extrabold after:mt-2 after:block after:h-[3px] after:w-8 after:bg-primary after:content-['']">
          {title}
        </h1>
        {description ? (
          <p className="mb-0 max-w-[65ch] text-sm text-ink-muted">
            {description}
          </p>
        ) : null}
        {actions ? (
          <div className="mt-3 flex flex-wrap gap-3">{actions}</div>
        ) : null}
      </div>
    </header>
  );
}
