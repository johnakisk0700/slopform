import { Chip } from "@heroui/react";

import {
  chipColor,
  type FeedbackBadge,
} from "../../../features/feedback/labels";

export interface FeedbackBadgesProps {
  badges: readonly FeedbackBadge[];
  size?: "sm" | "md";
  className?: string;
}

/**
 * Renders a conversation's status descriptors as HeroUI chips.
 *
 * Each badge always carries its own label, so the tone is reinforcement and
 * never the only signal — the accessibility invariant this screen leans on
 * hardest, because lifecycle, control and attention all live in the same row.
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
          <Chip color={chipColor(badge.tone)} size={size} variant="soft">
            <Chip.Label>{badge.label}</Chip.Label>
          </Chip>
        </li>
      ))}
    </ul>
  );
}
