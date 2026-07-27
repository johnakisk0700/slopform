import type { FeedbackAnswerQuestionKey } from "@join-the-six/database";

import type { FeedbackConversationGoal } from "../post-event-feedback-conversation.document.js";
import type {
  FeedbackExtractionContext,
  ValidatedFeedbackExtraction,
} from "./extraction.schemas.js";

export interface GoalStatusUpdate {
  readonly key: FeedbackConversationGoal["key"];
  readonly status: FeedbackConversationGoal["status"];
}

/**
 * Answered wins over everything, including a skip proposed in the same run.
 * Goals answered in an earlier run are re-derived rather than remembered, so a
 * replay that finds its answers already stored still repairs the statuses.
 *
 * "Asked" is deliberately not decided here. The model proposes a `nextGoal` and
 * a reply in the same breath as the answers it hopes will land; once validation
 * refuses some of those answers, that `nextGoal` is a wish about a world that
 * did not happen. The outbound seam is the only place that knows which question
 * the participant will actually see — mark `asked` from what it returned.
 */
export function resolveGoalStatuses(
  goals: readonly FeedbackConversationGoal[],
  context: FeedbackExtractionContext,
  validated: ValidatedFeedbackExtraction,
): GoalStatusUpdate[] {
  const answered = new Set<string>([
    ...context.acceptedAnswers.map((answer) => answer.questionKey),
    ...validated.answers.map((answer) => answer.questionKey),
  ]);
  const updates = new Map<string, GoalStatusUpdate>();

  for (const goal of goals) {
    if (answered.has(goal.key)) {
      updates.set(goal.key, { key: goal.key, status: "answered" });
    }
  }
  for (const key of validated.skippedGoals) {
    if (!answered.has(key)) {
      updates.set(key, { key, status: "skipped" });
    }
  }

  return [...updates.values()];
}

/**
 * The earliest goal that is still open once this run's recorded updates apply.
 *
 * Completion and the outbound re-ask both need the same answer: what is still
 * owed, in questionnaire order, after the answers and skips that actually
 * survived validation — never after the model's private belief about the ladder.
 */
export function nextOpenGoal(
  goals: readonly FeedbackConversationGoal[],
  updates: readonly GoalStatusUpdate[],
): FeedbackAnswerQuestionKey | null {
  const byKey = new Map(updates.map((update) => [update.key, update.status]));
  for (const goal of goals) {
    const status = byKey.get(goal.key) ?? goal.status;
    if (status !== "answered" && status !== "skipped") {
      return goal.key;
    }
  }
  return null;
}

/**
 * Records that the outbound this run is about to send is asking a particular
 * goal. No-ops when that goal is already terminal in the update list — an
 * answered or skipped question is not "asked" again just because the model
 * named it.
 */
export function withAskedGoal(
  updates: readonly GoalStatusUpdate[],
  askedGoal: FeedbackAnswerQuestionKey | undefined,
): GoalStatusUpdate[] {
  if (!askedGoal) {
    return [...updates];
  }
  if (
    updates.some(
      (update) =>
        update.key === askedGoal &&
        (update.status === "answered" || update.status === "skipped"),
    )
  ) {
    return [...updates];
  }
  const without = updates.filter((update) => update.key !== askedGoal);
  return [...without, { key: askedGoal, status: "asked" }];
}

export function isCompleting(
  goals: readonly FeedbackConversationGoal[],
  updates: readonly GoalStatusUpdate[],
): boolean {
  return nextOpenGoal(goals, updates) === null;
}
