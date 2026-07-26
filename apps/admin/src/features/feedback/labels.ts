import type { FeedbackCampaignConversationsDtoOutputCampaignStatus } from "../../api/generated/model/feedbackCampaignConversationsDtoOutputCampaignStatus";
import type { FeedbackConversationDetailDtoOutputControlMode } from "../../api/generated/model/feedbackConversationDetailDtoOutputControlMode";
import type { FeedbackConversationDetailDtoOutputLifecycleReason } from "../../api/generated/model/feedbackConversationDetailDtoOutputLifecycleReason";
import type { FeedbackConversationDetailDtoOutputMessagesItemActor } from "../../api/generated/model/feedbackConversationDetailDtoOutputMessagesItemActor";
import type { FeedbackConversationDetailDtoOutputMessagesItemAttentionCategoriesItem } from "../../api/generated/model/feedbackConversationDetailDtoOutputMessagesItemAttentionCategoriesItem";
import type { FeedbackConversationDetailDtoOutputMessagesItemAttentionRecommendedAction } from "../../api/generated/model/feedbackConversationDetailDtoOutputMessagesItemAttentionRecommendedAction";
import type { FeedbackConversationDetailDtoOutputMessagesItemDelivery } from "../../api/generated/model/feedbackConversationDetailDtoOutputMessagesItemDelivery";
import type { FeedbackConversationResultsDtoOutputAnswersItemQuestionKey } from "../../api/generated/model/feedbackConversationResultsDtoOutputAnswersItemQuestionKey";
import type { FeedbackConversationResultsDtoOutputNotesItemNoteType } from "../../api/generated/model/feedbackConversationResultsDtoOutputNotesItemNoteType";
import type { FeedbackConversationResultsDtoOutputNotesItemOrigin } from "../../api/generated/model/feedbackConversationResultsDtoOutputNotesItemOrigin";
import type { FeedbackConversationResultsDtoOutputNotesItemStatus } from "../../api/generated/model/feedbackConversationResultsDtoOutputNotesItemStatus";

/**
 * The screen's status vocabulary. Every badge pairs a `tone` with its own text,
 * so status is never carried by colour alone (admin accessibility invariant).
 * `chipColor` maps a tone onto the HeroUI `Chip` palette, which has no `info`
 * slot — slate statuses fall back to `default` and stay legible by their label.
 */
export type FeedbackTone =
  "neutral" | "info" | "success" | "warning" | "danger" | "accent";

export type FeedbackChipColor =
  "default" | "success" | "warning" | "danger" | "accent";

/**
 * How hard a badge should pull the eye.
 *
 * `strong` exists for one reason: a conversation needing attention sat in a row
 * of soft chips at exactly the same visual weight as "Open", so the one badge
 * an operator must not miss was the easiest to skim past. It renders as a solid
 * fill instead of a tint. Emphasis is never the only signal — every badge still
 * carries its own label.
 */
export type FeedbackEmphasis = "normal" | "strong";

export interface FeedbackBadge {
  /** Stable key for React lists. */
  key: string;
  label: string;
  tone: FeedbackTone;
  /** Defaults to `normal` when omitted. */
  emphasis?: FeedbackEmphasis;
}

/**
 * HeroUI's `primary` chip variant is the solid fill: it pairs `--warning` with
 * `--warning-foreground`, which the token bridge maps to
 * `--jts-color-warning` on `--jts-color-canvas` — 5.53:1 in light and 8.95:1 in
 * dark, both clear of AA. `soft` keeps the tinted pairing used everywhere else.
 */
export function chipVariant(
  emphasis: FeedbackEmphasis | undefined,
): "primary" | "soft" {
  return emphasis === "strong" ? "primary" : "soft";
}

export function chipColor(tone: FeedbackTone): FeedbackChipColor {
  switch (tone) {
    case "success":
      return "success";
    case "warning":
      return "warning";
    case "danger":
      return "danger";
    case "accent":
      return "accent";
    default:
      return "default";
  }
}

/**
 * The D18 fallback. Any participant id the backend could not resolve to a
 * current row renders as the agreed Greek placeholder rather than a raw UUID
 * or an empty cell.
 */
export const UNKNOWN_PARTICIPANT_LABEL = "άγνωστος συμμετέχων";

export function participantLabel(displayName: string | null): string {
  const trimmed = displayName?.trim() ?? "";
  return trimmed === "" ? UNKNOWN_PARTICIPANT_LABEL : trimmed;
}

/** True when the label had to fall back, so callers can mark it visually. */
export function isUnresolvedParticipant(displayName: string | null): boolean {
  return (displayName?.trim() ?? "") === "";
}

const QUESTION_LABELS: Record<
  FeedbackConversationResultsDtoOutputAnswersItemQuestionKey,
  string
> = {
  event_score: "Score",
  liked: "Liked",
  meet_again: "Meet again",
  avoid: "Avoid",
};

export function questionLabel(
  key: FeedbackConversationResultsDtoOutputAnswersItemQuestionKey,
): string {
  return QUESTION_LABELS[key];
}

/** Question keys in the order they are asked (§5), for filter controls. */
export const QUESTION_KEYS: readonly FeedbackConversationResultsDtoOutputAnswersItemQuestionKey[] =
  ["event_score", "liked", "meet_again", "avoid"];

const GOAL_STATUS_LABELS: Record<
  "pending" | "asked" | "answered" | "skipped",
  string
> = {
  pending: "Not asked",
  asked: "Awaiting reply",
  answered: "Answered",
  skipped: "Skipped",
};

const GOAL_STATUS_TONES: Record<
  "pending" | "asked" | "answered" | "skipped",
  FeedbackTone
> = {
  pending: "neutral",
  asked: "info",
  answered: "success",
  skipped: "neutral",
};

export function goalStatusBadge(
  status: "pending" | "asked" | "answered" | "skipped",
): FeedbackBadge {
  return {
    key: "goal-status",
    label: GOAL_STATUS_LABELS[status],
    tone: GOAL_STATUS_TONES[status],
  };
}

const NOTE_TYPE_LABELS: Record<
  FeedbackConversationResultsDtoOutputNotesItemNoteType,
  string
> = {
  activity_interest: "Activity interest",
  general: "General",
};

export function noteTypeLabel(
  noteType: FeedbackConversationResultsDtoOutputNotesItemNoteType,
): string {
  return NOTE_TYPE_LABELS[noteType];
}

export function reviewStatusBadge(
  status: FeedbackConversationResultsDtoOutputNotesItemStatus,
): FeedbackBadge {
  return status === "dismissed"
    ? { key: "review", label: "Dismissed", tone: "neutral" }
    : { key: "review", label: "Needs review", tone: "warning" };
}

const NOTE_ORIGIN_LABELS: Record<
  FeedbackConversationResultsDtoOutputNotesItemOrigin,
  string
> = {
  conversation: "From conversation",
  staff: "Staff note",
};

export function noteOriginLabel(
  origin: FeedbackConversationResultsDtoOutputNotesItemOrigin,
): string {
  return NOTE_ORIGIN_LABELS[origin];
}

/**
 * A note an operator typed must never be read as something a participant said.
 * Extraction output carries no badge — it is the default and the pane says so
 * in its heading — while a staff note is labelled wherever notes render.
 */
export function staffOriginBadge(
  origin: FeedbackConversationResultsDtoOutputNotesItemOrigin,
): FeedbackBadge | null {
  return origin === "staff"
    ? { key: "origin", label: NOTE_ORIGIN_LABELS.staff, tone: "accent" }
    : null;
}

const ACTOR_LABELS: Record<
  FeedbackConversationDetailDtoOutputMessagesItemActor,
  string
> = {
  bot: "Bot",
  participant: "Participant",
  staff: "Staff",
  system: "System",
};

export function actorLabel(
  actor: FeedbackConversationDetailDtoOutputMessagesItemActor,
): string {
  return ACTOR_LABELS[actor];
}

const MESSAGE_ATTENTION_CATEGORY_LABELS: Record<
  FeedbackConversationDetailDtoOutputMessagesItemAttentionCategoriesItem,
  string
> = {
  sexual_misconduct: "🍌 Sexual misconduct",
  harassment: "Harassment",
  violence_or_threat: "Violence or threat",
  self_harm: "Self-harm",
  other_safety: "Other safety concern",
};

export function messageAttentionCategoryLabel(
  category: FeedbackConversationDetailDtoOutputMessagesItemAttentionCategoriesItem,
): string {
  return MESSAGE_ATTENTION_CATEGORY_LABELS[category];
}

const MESSAGE_ATTENTION_ACTION_LABELS: Record<
  FeedbackConversationDetailDtoOutputMessagesItemAttentionRecommendedAction,
  string
> = {
  review: "Review",
  human_follow_up: "Human follow-up",
  urgent_human_follow_up: "Urgent human follow-up",
};

export function messageAttentionActionLabel(
  action: FeedbackConversationDetailDtoOutputMessagesItemAttentionRecommendedAction,
): string {
  return MESSAGE_ATTENTION_ACTION_LABELS[action];
}

export function controlLabel(
  mode: FeedbackConversationDetailDtoOutputControlMode,
): string {
  return mode === "human" ? "Human control" : "Bot control";
}

const LIFECYCLE_REASON_LABELS: Record<
  NonNullable<FeedbackConversationDetailDtoOutputLifecycleReason>,
  string
> = {
  completed: "Completed",
  stopped: "Stopped",
  expired: "Expired",
  cancelled: "Cancelled",
};

const LIFECYCLE_REASON_TONES: Record<
  NonNullable<FeedbackConversationDetailDtoOutputLifecycleReason>,
  FeedbackTone
> = {
  completed: "success",
  stopped: "danger",
  expired: "neutral",
  cancelled: "neutral",
};

export function lifecycleBadge(lifecycle: {
  state: "open" | "closed";
  reason: FeedbackConversationDetailDtoOutputLifecycleReason;
}): FeedbackBadge {
  if (lifecycle.state === "open") {
    return { key: "lifecycle", label: "Open", tone: "info" };
  }
  const reason = lifecycle.reason;
  if (reason === null) {
    return { key: "lifecycle", label: "Closed", tone: "neutral" };
  }
  return {
    key: "lifecycle",
    label: LIFECYCLE_REASON_LABELS[reason],
    tone: LIFECYCLE_REASON_TONES[reason],
  };
}

const CAMPAIGN_STATUS_LABELS: Record<
  FeedbackCampaignConversationsDtoOutputCampaignStatus,
  string
> = {
  launched: "Launched",
  paused: "Paused",
  closed: "Closed",
};

const CAMPAIGN_STATUS_TONES: Record<
  FeedbackCampaignConversationsDtoOutputCampaignStatus,
  FeedbackTone
> = {
  launched: "success",
  paused: "warning",
  closed: "neutral",
};

export function campaignStatusBadge(
  status:
    | FeedbackCampaignConversationsDtoOutputCampaignStatus
    | "launched"
    | "paused"
    | "closed",
): FeedbackBadge {
  return {
    key: "campaign-status",
    label: CAMPAIGN_STATUS_LABELS[status],
    tone: CAMPAIGN_STATUS_TONES[status],
  };
}

/**
 * Outbound delivery state, read from the outbox correlation the backend
 * attaches to bot and staff messages. Provider delivery (`deliveryStatus`)
 * outranks the outbox row's own status once the transport reports back.
 */
export function deliveryBadge(
  delivery: FeedbackConversationDetailDtoOutputMessagesItemDelivery,
): FeedbackBadge | null {
  if (delivery === null) {
    return null;
  }

  if (delivery.deliveryStatus === "error") {
    return { key: "delivery", label: "Delivery failed", tone: "danger" };
  }
  if (
    delivery.deliveryStatus === "read" ||
    delivery.deliveryStatus === "played"
  ) {
    return { key: "delivery", label: "Read", tone: "success" };
  }
  if (delivery.deliveryStatus === "delivered") {
    return { key: "delivery", label: "Delivered", tone: "success" };
  }

  switch (delivery.outboxStatus) {
    case "failed":
      return { key: "delivery", label: "Delivery failed", tone: "danger" };
    case "cancelled":
      return { key: "delivery", label: "Cancelled", tone: "neutral" };
    case "sent":
      return { key: "delivery", label: "Sent", tone: "info" };
    case "sending":
      return { key: "delivery", label: "Sending", tone: "info" };
    case "held":
      return { key: "delivery", label: "Held", tone: "warning" };
    default:
      return { key: "delivery", label: "Queued", tone: "neutral" };
  }
}
