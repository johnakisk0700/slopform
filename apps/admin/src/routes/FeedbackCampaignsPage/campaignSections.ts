import {
  Archive,
  CalendarClock,
  Layers,
  PauseCircle,
  Rocket,
  type LucideIcon,
} from "lucide-react";

import type { FeedbackCampaignListDtoOutputItemsItem } from "../../api/generated/model/feedbackCampaignListDtoOutputItemsItem";
import type { FeedbackCampaignListDtoOutputItemsItemStatus } from "../../api/generated/model/feedbackCampaignListDtoOutputItemsItemStatus";

export type CampaignRow = FeedbackCampaignListDtoOutputItemsItem;

export type CampaignStatus = FeedbackCampaignListDtoOutputItemsItemStatus;

export interface CampaignSectionSpec {
  status: CampaignStatus;
  Icon: LucideIcon;
  /** The glyph's own colour. Matches the status tone `campaignStatusBadge` gives. */
  tint: string;
  /** One line saying what being in this section means for the operator. */
  lede: string;
}

/**
 * Reading order, and it is triage order rather than the API's newest-first.
 *
 * A launched campaign is collecting answers right now; a paused one is a
 * decision somebody has to come back and make; a closed one is history. Sorting
 * by launch time across all three mixed those together, so the campaign that
 * had been sitting paused for a week was wherever its launch date happened to
 * put it.
 *
 * The glyphs are the ones this feature already speaks in — `Archive` heads the
 * closed conversations in `ConversationList`, `PauseCircle` is the pause control
 * in `CampaignHeader`, and `Rocket` is the launch action at the bottom of this
 * very page, so a campaign appears under the glyph of the button that created
 * it. Nothing new was drawn for this.
 */
/**
 * How the picker is arranged. Two answers to two different questions.
 *
 * «By status» answers «what needs me?» and is the default, because that is why
 * an operator opens this screen. «By date» answers «which dinner was that?» —
 * one run of cards newest first, which is the only order that works when you
 * are looking for a campaign whose state you do not remember.
 *
 * It is a view toggle and nothing else: same campaigns, same cards, no filter.
 * Nothing is ever hidden by switching, so there is no state in which the
 * operator is looking at a subset without being told.
 */
export type CampaignOrdering = "status" | "date";

export const ORDERING_OPTIONS: ReadonlyArray<{
  value: CampaignOrdering;
  label: string;
  Icon: LucideIcon;
}> = [
  { value: "status", label: "By status", Icon: Layers },
  { value: "date", label: "By date", Icon: CalendarClock },
];

/** Matches `AdminUserMenu`'s appearance chips — the app's one segmented look. */
export const CHOICE_CHIP =
  "justify-center gap-1.5 rounded-md border border-border bg-transparent px-2 text-ink " +
  "data-[selected]:border-primary-border data-[selected]:bg-primary-soft data-[selected]:text-primary";

export const CAMPAIGN_SECTIONS: readonly CampaignSectionSpec[] = [
  {
    status: "launched",
    Icon: Rocket,
    tint: "text-success",
    lede: "Collecting answers now.",
  },
  {
    status: "paused",
    Icon: PauseCircle,
    tint: "text-warning",
    lede: "Nothing is going out until somebody resumes these.",
  },
  {
    status: "closed",
    Icon: Archive,
    tint: "text-ink-subtle",
    lede: "Finished. Read-only, kept for their results.",
  },
];
