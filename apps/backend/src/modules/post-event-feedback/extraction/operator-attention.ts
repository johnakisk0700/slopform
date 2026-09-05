import type { FeedbackExtractionValidationResult } from "./validate-proposal.js";
import type {
  ValidatedFeedbackExtraction,
  ValidatedFeedbackSafetySignal,
} from "./extraction.schemas.js";
import {
  RESPONDENT_SOURCE_SAFETY_CATEGORIES,
  strongerRecommendedAction,
  type PostEventFeedbackAttentionReason,
  type PostEventFeedbackRecommendedAction,
  type PostEventFeedbackSafetyCategory,
} from "../attention.js";

/** One reason to raise, and the message an operator should be reading. */
export interface FeedbackOperatorAttentionRaise {
  readonly kind: PostEventFeedbackAttentionReason;
  readonly messageId: string | null;
}

/**
 * Why a hostile conversation needs a person. `stopped` is after the exit line;
 * `unanswerable` is a hostile empty ladder that still has rungs. Same inbox
 * reason; the call site uses the distinction for whether the bot may still speak.
 */
export type FeedbackHostilityRaise = "none" | "stopped" | "unanswerable";

/**
 * Hostile turns that still earn a calm reply before the application-owned exit
 * line. Three is the product threshold; a later civil message after resume
 * must not trip on a standing counter alone.
 */
export const FEEDBACK_CALM_REPLIES_BEFORE_HOSTILITY_STOP = 3;

/**
 * Whether this run sends the hostility exit line and goes quiet.
 *
 * Requires hostility *in this run* (a standing counter after `resumeBot` must
 * not freeze a civil message), `hostileTurns` including this run strictly above
 * the calm-reply threshold, and no safety signals. Any safety signal blocks the
 * stop and the counter tick — a disclosure must never receive the exit line.
 * Categories are ignored: respondent-source abuse still keeps the bot talking
 * (D13).
 */
export function stopsForHostility(input: {
  readonly hostileTurn: boolean;
  readonly hostileTurns: number;
  readonly safetySignalCount: number;
}): boolean {
  return (
    input.hostileTurn &&
    input.safetySignalCount === 0 &&
    input.hostileTurns > FEEDBACK_CALM_REPLIES_BEFORE_HOSTILITY_STOP
  );
}

/**
 * Whether this run ticks the durable hostility ladder. Safety signals never
 * count: incrementing on a disclosure would move the exit line toward it.
 */
export function countsAsHostileTurn(input: {
  readonly hostileMessageIds: readonly string[];
  readonly safetySignalCount: number;
}): boolean {
  return input.safetySignalCount === 0 && input.hostileMessageIds.length > 0;
}

/**
 * Named inbox raises for this run. Safety and handoff are the incident path;
 * D18 notes and answer revisions are quieter work. Raises without their own
 * citation (handoff, revision, withdrawal, hostility) anchor on the newest
 * participant message this run read. `withdrew` is passed in because it
 * depends on what actually reached the phone. `stalledOnMessageId` is the one
 * raise anchored on a bot sentence (the spent re-ask wording).
 */
export function operatorAttentionRaises(
  validated: FeedbackExtractionValidationResult,
  newestParticipantMessageId: string | null,
  withdrew = false,
  hostility: FeedbackHostilityRaise = "none",
  stalledOnMessageId: string | null = null,
  unansweredDataQuestionMessageIds: readonly string[] = [],
): FeedbackOperatorAttentionRaise[] {
  const raises: FeedbackOperatorAttentionRaise[] = [];

  for (const attention of groupSafetySignalsByMessage(
    validated.safetySignals,
  )) {
    // Respondent-source-only → `respondent_conduct`. Any other category →
    // `safety`. A burst that is both raises both; each dismisses on its own.
    const respondentSource = attention.categories.some((category) =>
      RESPONDENT_SOURCE_SAFETY_CATEGORIES.has(category),
    );
    if (respondentSource) {
      raises.push({
        kind: "respondent_conduct",
        messageId: attention.messageId,
      });
    }
    if (
      !attention.categories.every((category) =>
        RESPONDENT_SOURCE_SAFETY_CATEGORIES.has(category),
      )
    ) {
      raises.push({ kind: "safety", messageId: attention.messageId });
    }
  }
  if (validated.handoff) {
    raises.push({ kind: "handoff", messageId: newestParticipantMessageId });
  }
  for (const note of validated.notes) {
    // D18: subjectless flagged notes cite the message that typed the name.
    if (note.flaggedForReview) {
      raises.push({
        kind: "unattributed_note",
        messageId: note.sourceMessageIds[0] ?? null,
      });
    }
  }
  if (validated.conflictingAnswerRevision) {
    raises.push({
      kind: "answer_revision",
      messageId: newestParticipantMessageId,
    });
  }
  // Withdrawal is an unfinished questionnaire, not a hostility verdict.
  if (withdrew) {
    raises.push({
      kind: "unfinished_questionnaire",
      messageId: newestParticipantMessageId,
    });
  }
  // Hostility is one reason; do not also raise `unfinished_questionnaire`.
  if (hostility !== "none") {
    raises.push({
      kind: "hostile_to_bot",
      messageId: newestParticipantMessageId,
    });
  }
  // Re-ask cap spent: same operator job as a withdrawal. Anchor on the bot
  // message that already carried the copy so later participant turns do not
  // mint duplicate reasons.
  if (stalledOnMessageId) {
    raises.push({
      kind: "unfinished_questionnaire",
      messageId: stalledOnMessageId,
    });
  }
  // Recognised unanswered data question. One row per asking message; replay-
  // idempotent on that id.
  for (const messageId of unansweredDataQuestionMessageIds) {
    raises.push({ kind: "unanswered_data_question", messageId });
  }

  return raises;
}

/**
 * Citations whose answers must be written with `matching_hold`. The hold
 * follows the citation in this run only: abuse in a later burst leaves the
 * earlier row unheld (`respondent_conduct` is then the operator path). Holding
 * every stored answer would mark unrelated people.
 */
export function respondentSourceMessageIds(
  signals: readonly ValidatedFeedbackSafetySignal[],
): ReadonlySet<string> {
  const held = new Set<string>();
  for (const signal of signals) {
    if (RESPONDENT_SOURCE_SAFETY_CATEGORIES.has(signal.category)) {
      for (const messageId of signal.sourceMessageIds) {
        held.add(messageId);
      }
    }
  }
  return held;
}

export function isSafetyOrHandoffAttention(
  validated: ValidatedFeedbackExtraction,
): boolean {
  return validated.safetySignals.length > 0 || validated.handoff;
}

interface GroupedMessageAttention {
  readonly messageId: string;
  readonly categories: readonly PostEventFeedbackSafetyCategory[];
  readonly recommendedAction: PostEventFeedbackRecommendedAction;
  readonly confidence: number;
}

export function groupSafetySignalsByMessage(
  signals: readonly ValidatedFeedbackSafetySignal[],
): GroupedMessageAttention[] {
  const grouped = new Map<
    string,
    {
      categories: Set<PostEventFeedbackSafetyCategory>;
      recommendedAction: PostEventFeedbackRecommendedAction;
      confidence: number;
    }
  >();

  for (const signal of signals) {
    for (const messageId of signal.sourceMessageIds) {
      const current = grouped.get(messageId);
      if (current) {
        current.categories.add(signal.category);
        current.recommendedAction = strongerRecommendedAction(
          current.recommendedAction,
          signal.recommendedAction,
        );
        current.confidence = Math.max(current.confidence, signal.confidence);
      } else {
        grouped.set(messageId, {
          categories: new Set([signal.category]),
          recommendedAction: signal.recommendedAction,
          confidence: signal.confidence,
        });
      }
    }
  }

  return [...grouped.entries()].map(([messageId, attention]) => ({
    messageId,
    categories: [...attention.categories],
    recommendedAction: attention.recommendedAction,
    confidence: attention.confidence,
  }));
}
