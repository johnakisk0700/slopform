import type { ReactNode } from "react";
import { clsx } from "clsx";
import { Link } from "react-router";

import { BrandMark } from "./BrandMark";

interface BrandLockupProps {
  /**
   * Which surface the lockup sits on. The mark uses its inverse lower fill
   * on a strong surface; the wordmark inherits the parent's text tone.
   */
  surface?: "strong" | "default";
  /** When set, the lockup is a home link; omit for a static mark (e.g. auth status). */
  to?: string;
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
  /** Tone for the tagline; it carries the shared metadata label recipe. */
  taglineClassName?: string;
}

/**
 * Product logo + “Slopform” wordmark. Use on shell, sign-in, error and auth
 * status. BrandMark owns the shared two-piece S.
 */
export function BrandLockup({
  surface = "default",
  to,
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
      Slopform
    </span>
  );

  const content = (
    <>
      {/* The mark grows with the lockup: against a two-line stack a 36px mark
          reads as an icon beside the words, where 40px reads as the logo the
          words belong to — a little taller than the text block on both edges,
          which is what makes the three parts sit as one. */}
      <BrandMark surface={surface} className={tagline ? "size-10" : "size-9"} />
      {tagline ? (
        // Both lines set solid. The overline recipe carries no line-height, so
        // without `leading-none` the tagline inherits the 1.6 body leading and
        // opens a gap taller than the label — the wordmark and the
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
        aria-label="Slopform admin home"
        className={clsx(
          "inline-flex items-center gap-1.5 no-underline",
          className,
        )}
      >
        {content}
      </Link>
    );
  }

  return (
    <div className={clsx("inline-flex items-center gap-1.5", className)}>
      {content}
    </div>
  );
}
