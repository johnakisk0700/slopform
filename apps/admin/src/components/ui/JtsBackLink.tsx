import { ChevronLeft } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";

export interface JtsBackLinkProps {
  /** The route this returns to. */
  to: string;
  /** «Back to …» — the destination named the way its own screen names itself. */
  children: ReactNode;
}

/**
 * The one way out of a detail screen.
 *
 * Four screens grew four of these — a chevron here, an arrow there, one wrapped
 * in a `<p>`, one filed under a header's `actions` row with no glyph at all —
 * and the operator relearned the exit on every route. This is the single
 * affordance: left chevron, wine, `Back to <place>`, always above the title.
 *
 * It is not a peer of a screen's actions. Those do something *to* the thing on
 * screen; this leaves it. `JtsPageHeader` takes it as `back` so the ordering is
 * not a per-page decision; a screen with no `JtsPageHeader` (an error branch, a
 * compact header) renders it directly.
 *
 * The chevron slides a hair on hover — the whole animation the pattern gets,
 * and the base layer's reduced-motion rule collapses it.
 */
export function JtsBackLink({ to, children }: JtsBackLinkProps) {
  return (
    <Link
      to={to}
      className="group inline-flex w-fit items-center gap-1.5 self-start text-sm font-semibold text-primary no-underline hover:text-primary-hover"
    >
      <ChevronLeft
        aria-hidden="true"
        className="size-4 shrink-0 transition-transform group-hover:-translate-x-0.5"
      />
      {children}
    </Link>
  );
}
