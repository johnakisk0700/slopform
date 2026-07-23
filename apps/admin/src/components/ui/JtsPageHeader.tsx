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
          <p className="mb-3 text-xs font-extrabold uppercase tracking-caps text-primary">
            {eyebrow}
          </p>
        ) : null}
        <h1 className="mb-2 font-display text-[clamp(1.75rem,_1.4rem_+_1.4vw,_2.6rem)] font-extrabold tracking-tighter after:mt-3 after:block after:h-[3px] after:w-11 after:bg-primary after:content-['']">
          {title}
        </h1>
        {description ? (
          <p className="mb-0 max-w-[65ch] text-base text-ink-muted">
            {description}
          </p>
        ) : null}
        {actions ? (
          <div className="mt-5 flex flex-wrap gap-3">{actions}</div>
        ) : null}
      </div>
    </header>
  );
}
