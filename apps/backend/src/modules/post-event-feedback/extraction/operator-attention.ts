import type { FeedbackExtractionValidationResult } from "./validate-proposal.js";
import type {
  ValidatedFeedbackExtraction,
  ValidatedFeedbackSafetySignal,
} from "./extraction.schemas.js";
import {
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
 * Everything about this run that should surface in the admin inbox, named.
 *
 * This used to answer `true`, which is the whole defect: safety and handoff are
 * the incident path (D13), while a flagged subjectless note (D18) and a refused
 * answer revision are quieter inbox work — and all four arrived as one badge
 * that said nothing and could not be cleared, because there was nothing
 * specific enough to clear.
 *
 * Three of the five carry no citation of their own. An explicit handoff is a
 * property of the run rather than of a line, a refused revision is about the
 * *stored* answer it disagreed with, and a withdrawal is about the run deciding
 * to stop; all three are anchored on the newest message this run read, which is
 * the burst an operator wants open. That is a weaker claim than the safety
 * anchor and deliberately so — the alternative is a reason that links nowhere.
 *
 * `withdrew` is passed in rather than derived here because it depends on what
 * actually reached the phone, which only the run knows. It belongs in this list
 * all the same: a withdrawal used to raise the bare flag, so the one situation
 * where the bot gave up on a questionnaire was also the one an operator could
 * not read or dismiss.
 */
export function operatorAttentionRaises(
  validated: FeedbackExtractionValidationResult,
  newestParticipantMessageId: string | null,
  withdrew = false,
): FeedbackOperatorAttentionRaise[] {
  const raises: FeedbackOperatorAttentionRaise[] = [];

  for (const attention of groupSafetySignalsByMessage(
    validated.safetySignals,
  )) {
    raises.push({ kind: "safety", messageId: attention.messageId });
  }
  if (validated.handoff) {
    raises.push({ kind: "handoff", messageId: newestParticipantMessageId });
  }
  for (const note of validated.notes) {
    // D18 flags exactly the notes whose mention resolved to nobody, so the
    // note's own first citation is where the unattributable name was typed.
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
  // Named for the outcome an operator has to decide about — a questionnaire
  // that stopped short — rather than for the bot's decision to bow out. The two
  // are the same event; only one of them tells the operator what is on their
  // plate. Not `hostile_to_bot`: rule 7δ withdraws on silence, not on rudeness.
  if (withdrew) {
    raises.push({
      kind: "unfinished_questionnaire",
      messageId: newestParticipantMessageId,
    });
  }

  return raises;
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
