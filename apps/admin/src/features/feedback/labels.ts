import type { FeedbackCampaignConversationsDtoOutputCampaignStatus } from "../../api/generated/model/feedbackCampaignConversationsDtoOutputCampaignStatus";
import type { FeedbackConversationDetailDtoOutputAttentionReasonsItemKind } from "../../api/generated/model/feedbackConversationDetailDtoOutputAttentionReasonsItemKind";
import type { FeedbackConversationDetailDtoOutputControlMode } from "../../api/generated/model/feedbackConversationDetailDtoOutputControlMode";
import type { FeedbackConversationDetailDtoOutputGoalsItemStatus } from "../../api/generated/model/feedbackConversationDetailDtoOutputGoalsItemStatus";
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
 * `FeedbackBadges` owns how each tone paints — one pale pairing per tone,
 * including the slate `info` that HeroUI's chip palette cannot express.
 */
export type FeedbackTone =
  "neutral" | "info" | "success" | "warning" | "danger" | "accent";

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
  FeedbackConversationDetailDtoOutputGoalsItemStatus,
  string
> = {
  pending: "Not asked",
  asked: "Awaiting reply",
  answered: "Answered",
  skipped: "Skipped",
};

const GOAL_STATUS_TONES: Record<
  FeedbackConversationDetailDtoOutputGoalsItemStatus,
  FeedbackTone
> = {
  pending: "neutral",
  asked: "info",
  answered: "success",
  skipped: "neutral",
};

export function goalStatusBadge(
  status: FeedbackConversationDetailDtoOutputGoalsItemStatus,
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
  abuse_of_a_participant: "Abuse of a participant",
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

/**
 * Why a conversation is asking for a person, in one plain sentence each.
 *
 * These are the whole point of the reason list: «Needs attention» said only
 * that something was wrong, and a dozen unrelated situations arrived in the
 * inbox looking identical. Each line says what happened, not what to do about
 * it — what to do is the operator's call once they have read the message it
 * links to.
 *
 * Some sentences deliberately cover more than one cause, because the backend
 * gives them one name when the operator's next move is the same either way: a
 * message cut short and a message edited after the fact are both «go and read
 * the original», and a send that failed and a send too long to record are both
 * «they never got this». Splitting them here would put a distinction on screen
 * that makes no difference to anybody reading it.
 *
 * `safety` and `respondent_conduct` are the reverse case — two sentences for one
 * classification, because the difference is who the operator is opening the
 * conversation for. Read «a message raised a safety concern» and you go in
 * looking for the person to support; the second sentence says the person who
 * wrote to us is the one to read about.
 */
const ATTENTION_REASON_LABELS: Record<
  FeedbackConversationDetailDtoOutputAttentionReasonsItemKind,
  string
> = {
  safety: "A message raised a safety concern.",
  respondent_conduct: "The participant abused someone they named.",
  handoff: "The participant asked to speak to a person.",
  unattributed_note: "A note could not be attributed to anyone.",
  answer_revision: "An answer was revised after it had been recorded.",
  hostile_to_bot: "The participant was hostile to the bot.",
  unfinished_questionnaire:
    "The bot stopped asking before the questionnaire was finished.",
  extraction_failed: "Nothing could be extracted from what was said here.",
  unreadable_message:
    "Something arrived with no text to read — a voice note, or media.",
  transcript_mismatch:
    "The transcript is not a faithful copy of a message that arrived.",
  transcript_full: "The transcript is full, so nothing more can be recorded.",
  undelivered_message: "A message the bot wrote never reached the participant.",
  post_closure_message:
    "The participant wrote after the conversation had closed.",
  stopped_without_answers:
    "The participant stopped without having answered anything.",
};

export function attentionReasonLabel(
  kind: FeedbackConversationDetailDtoOutputAttentionReasonsItemKind,
): string {
  return ATTENTION_REASON_LABELS[kind];
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
  declined: "Declined",
  stopped: "Stopped",
  expired: "Expired",
  cancelled: "Cancelled",
};

const LIFECYCLE_REASON_TONES: Record<
  NonNullable<FeedbackConversationDetailDtoOutputLifecycleReason>,
  FeedbackTone
> = {
  completed: "success",
  // Neutral, not danger. He answered the questions — the answer was no — and an
  // operator opening this list is looking for rows to act on, which this is not.
  declined: "neutral",
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
 * True while an outbound message is in the transcript but not yet with the
 * participant.
 *
 * The transcript records what the bot decided to say the moment the outbox row
 * is committed, which is deliberate — an operator needs to see the decision —
 * but a recorded message is not a received one. On 2026-07-27 those two were
 * indistinguishable on screen while delivery sat behind model calls for up to
 * 147 seconds, so a reply the participant had never seen read exactly like one
 * they had already answered.
 */
export function isAwaitingDelivery(
  delivery: FeedbackConversationDetailDtoOutputMessagesItemDelivery,
): boolean {
  if (delivery === null) {
    return false;
  }
  // The transport has reported back, so this is no longer ours to wait on —
  // `error` included, which the badge shows as a failure rather than a wait.
  if (
    delivery.deliveryStatus === "delivered" ||
    delivery.deliveryStatus === "read" ||
    delivery.deliveryStatus === "played" ||
    delivery.deliveryStatus === "error"
  ) {
    return false;
  }
  return (
    delivery.outboxStatus === "pending" ||
    delivery.outboxStatus === "sending" ||
    delivery.outboxStatus === "held"
  );
}

/**
 * Why an outbound message is still waiting, in one line.
 *
 * Deliberately does not say the send is being held back to see whether the
 * participant writes again. It is not: `superseded_by_newer_testimony` is
 * checked before the outbox row is written and never again, and a queued row is
 * withdrawn only by STOP, a human takeover or expiry. A newer message from the
 * participant will not stop this one going out, and the screen should not
 * suggest otherwise.
 */
export function awaitingDeliveryReason(
  delivery: FeedbackConversationDetailDtoOutputMessagesItemDelivery,
): string | null {
  if (delivery === null || !isAwaitingDelivery(delivery)) {
    return null;
  }
  return delivery.outboxStatus === "held"
    ? "Held while the campaign is paused — not seen by the participant."
    : "Waiting to be sent — not seen by the participant yet.";
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
    // Handed to the transport with nothing reported back: the ordinary end of
    // every outbound message. Badging it put a chip under almost every bubble
    // in the transcript, which is exactly how a badge stops being read — the
    // exceptions above and below are what an operator needs to see.
    case "sent":
      return null;
    case "sending":
      return { key: "delivery", label: "Sending", tone: "info" };
    case "held":
      return { key: "delivery", label: "Held", tone: "warning" };
    default:
      return { key: "delivery", label: "Queued", tone: "neutral" };
  }
}
