import type { FeedbackExtractionValidationResult } from "../post-event-feedback-extraction-validation.js";
import type {
  ValidatedFeedbackExtraction,
  ValidatedFeedbackSafetySignal,
} from "../post-event-feedback-extraction.schemas.js";
import {
  strongerRecommendedAction,
  type PostEventFeedbackRecommendedAction,
  type PostEventFeedbackSafetyCategory,
} from "../post-event-feedback-attention.js";

/**
 * Anything that should surface in the admin inbox. Safety and handoff are the
 * incident path (D13); a flagged subjectless note (D18) and a refused answer
 * revision are quieter — the safeguard already wrote the note or kept the
 * stored value, and without the flag nobody would know to look.
 */
export function needsOperatorAttention(
  validated: FeedbackExtractionValidationResult,
): boolean {
  return (
    isSafetyOrHandoffAttention(validated) ||
    validated.notes.some((note) => note.flaggedForReview) ||
    validated.conflictingAnswerRevision
  );
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
