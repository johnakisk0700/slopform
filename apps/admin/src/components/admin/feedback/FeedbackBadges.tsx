import { clsx } from "clsx";
import type { LucideIcon } from "lucide-react";

import type {
  FeedbackBadge,
  FeedbackTone,
} from "../../../features/feedback/labels";

/**
 * A badge with an optional glyph. The icon lives on this component's type and
 * not on `FeedbackBadge` itself, because `features/feedback/` is React-free
 * and an icon is a rendering concern — the label still carries the meaning on
 * its own, per the status invariant.
 */
export type FeedbackBadgeWithIcon = FeedbackBadge & { glyph?: LucideIcon };

interface FeedbackBadgesProps {
  badges: readonly FeedbackBadgeWithIcon[];
  size?: "sm" | "md";
  className?: string;
}

/**
 * How each tone paints: a pale wash of its own status colour, a hairline of the
 * same hue, and the status colour as text.
 *
 * The tinted fill is what makes a column of rows readable at a glance — an
 * operator finds the amber and the red before reading a single word. HeroUI's
 * `Chip` cannot express this set: it has no `info` slot, so every slate status
 * fell back to the same grey as `neutral` and «Open» looked exactly like
 * «Cancelled». These are the jts status tokens directly, so both themes flip
 * with them and nothing here branches on the theme.
 */
const TONE_STYLES: Record<FeedbackTone, string> = {
  neutral: "border-border bg-surface-sunken text-ink-muted",
  info: "border-info-border bg-info-soft text-info",
  success: "border-success-border bg-success-soft text-success",
  warning: "border-warning-border bg-warning-soft text-warning",
  danger: "border-danger-border bg-danger-soft text-danger",
  // Copper measures 3.93:1 on surface — under AA at this size — so the accent
  // stays in the fill and the hairline, and the label keeps full-contrast ink.
  accent: "border-copper/40 bg-copper-soft text-ink",
};

/**
 * The solid counterpart, for the one badge an operator must not skim past.
 * Every status fill pairs with `canvas` in the token bridge, which is what
 * keeps the pairing AA-safe in both themes.
 */
const STRONG_TONE_STYLES: Record<FeedbackTone, string> = {
  neutral: "border-transparent bg-ink-muted text-canvas",
  info: "border-transparent bg-info text-canvas",
  success: "border-transparent bg-success text-canvas",
  warning: "border-transparent bg-warning text-canvas",
  danger: "border-transparent bg-danger text-canvas",
  accent: "border-transparent bg-copper text-canvas",
};

const SIZE_STYLES: Record<"sm" | "md", string> = {
  sm: "px-1.5 py-px text-[length:var(--jts-text-2xs)]",
  md: "px-2 py-0.5 text-xs",
};

/**
 * Renders a conversation's status descriptors as colour-coded pills.
 *
 * Each badge always carries its own label, so the tone is reinforcement and
 * never the only signal — the accessibility invariant this screen leans on
 * hardest, because lifecycle, control and attention all live in the same row.
 *
 * A `strong` badge renders solid rather than tinted. Both pairings come from
 * the token bridge and are AA-safe in either theme, so the emphasis is a
 * hierarchy decision rather than a contrast risk.
 */
export function FeedbackBadges({
  badges,
  size = "sm",
  className,
}: FeedbackBadgesProps) {
  if (badges.length === 0) {
    return null;
  }

  return (
    <ul className={className ?? "flex flex-wrap items-center gap-1.5"}>
      {badges.map((badge) => (
        <li key={badge.key}>
          <span
            className={clsx(
              "inline-flex items-center gap-1 rounded-sm border font-semibold whitespace-nowrap",
              SIZE_STYLES[size],
              badge.emphasis === "strong"
                ? STRONG_TONE_STYLES[badge.tone]
                : TONE_STYLES[badge.tone],
            )}
          >
            {badge.glyph ? (
              <badge.glyph aria-hidden="true" className="size-3 shrink-0" />
            ) : null}
            {badge.label}
          </span>
        </li>
      ))}
    </ul>
  );
}
