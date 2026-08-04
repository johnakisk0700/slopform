import type { ReactNode } from "react";
import { clsx } from "clsx";
import { Link } from "react-router";

import { BrandMark } from "./BrandMark";

interface BrandLockupProps {
  /**
   * Which slab the lockup sits on. The wordmark still inherits the parent
   * text tone; the mark takes the theme's brand colour that belongs on that
   * slab (`sidebar-active-index` on the inverse panel, `primary` on paper).
   * Noir's brand is ink / near-white, so the mark stays monochrome there —
   * that is the theme saying so, not a special case in this component.
   */
  surface?: "strong" | "default";
  /** When set, the lockup is a home link; omit for a static mark (e.g. auth status). */
  to?: string;
  /** Accessible name when `to` is set; ignored for the static mark. */
  ariaLabel?: string;
  className?: string;
  /** Override the default wordmark span (e.g. `Drawer.Heading`). */
  wordmark?: ReactNode;
  /** Classes for the default wordmark span; ignored when `wordmark` is passed. */
  wordmarkClassName?: string;
  /**
   * Second line under the wordmark — what this surface is ("Admin workspace").
   * It sets to the wordmark's left edge and the mark centres against the pair,
   * so the descriptor belongs to the lockup instead of trailing below it.
   */
  tagline?: ReactNode;
  /** Tone for the tagline; it carries the shared micro-caps recipe already. */
  taglineClassName?: string;
}

/**
 * Product logo + “Join The Six” wordmark. Use on shell, sign-in, error and auth
 * status. The CSS six-dot `.brand-mark` remains a decorative motif only.
 */
export function BrandLockup({
  surface = "default",
  to,
  ariaLabel = "Join The Six admin home",
  className,
  wordmark,
  wordmarkClassName,
  tagline,
  taglineClassName,
}: BrandLockupProps) {
  const label = wordmark ?? (
    <span
      className={clsx(
        "font-brand font-extrabold tracking-tight",
        // leading-none so a tagline sits one hairline under the wordmark
        // rather than a full body line-height away from it.
        "leading-none",
        wordmarkClassName ?? "text-[1.3rem]",
      )}
    >
      Join The Six
    </span>
  );

  // Size must travel with the tone class: BrandMark treats a passed className
  // as a full override of its default h-9, so a colour-only string would
  // collapse the mark.
  const markClassName = clsx(
    tagline ? "h-10 w-10" : "h-9 w-9",
    surface === "strong" ? "text-sidebar-active-index" : "text-primary",
  );

  const content = (
    <>
      {/* The mark grows with the lockup: against a two-line stack a 36px mark
          reads as an icon beside the words, where 40px reads as the logo the
          words belong to — a little taller than the text block on both edges,
          which is what makes the three parts sit as one. */}
      <BrandMark className={markClassName} />
      {tagline ? (
        // Both lines set solid. The overline recipe carries no line-height, so
        // without `leading-none` the tagline inherits the 1.6 body leading and
        // opens a gap taller than its own capitals — the wordmark and the
        // descriptor then read as two stranded lines rather than one block.
        <span className="grid gap-1">
          {label}
          <span className={clsx("jts-overline leading-none", taglineClassName)}>
            {tagline}
          </span>
        </span>
      ) : (
        label
      )}
    </>
  );

  if (to) {
    return (
      <Link
        to={to}
        aria-label={ariaLabel}
        className={clsx(
          "inline-flex items-center gap-3 no-underline",
          className,
        )}
      >
        {content}
      </Link>
    );
  }

  return (
    <div className={clsx("inline-flex items-center gap-3", className)}>
      {content}
    </div>
  );
}
