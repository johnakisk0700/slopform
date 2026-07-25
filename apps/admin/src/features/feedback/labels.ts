import type { FeedbackCampaignConversationsDtoOutputCampaignStatus } from "../../api/generated/model/feedbackCampaignConversationsDtoOutputCampaignStatus";
import type { FeedbackConversationDetailDtoOutputControlMode } from "../../api/generated/model/feedbackConversationDetailDtoOutputControlMode";
import type { FeedbackConversationDetailDtoOutputLifecycleReason } from "../../api/generated/model/feedbackConversationDetailDtoOutputLifecycleReason";
import type { FeedbackConversationDetailDtoOutputMessagesItemActor } from "../../api/generated/model/feedbackConversationDetailDtoOutputMessagesItemActor";
import type { FeedbackConversationDetailDtoOutputMessagesItemDelivery } from "../../api/generated/model/feedbackConversationDetailDtoOutputMessagesItemDelivery";
import type { FeedbackConversationResultsDtoOutputAnswersItemQuestionKey } from "../../api/generated/model/feedbackConversationResultsDtoOutputAnswersItemQuestionKey";
import type { FeedbackConversationResultsDtoOutputNotesItemNoteType } from "../../api/generated/model/feedbackConversationResultsDtoOutputNotesItemNoteType";
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

export interface FeedbackBadge {
  /** Stable key for React lists. */
  key: string;
  label: string;
  tone: FeedbackTone;
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
