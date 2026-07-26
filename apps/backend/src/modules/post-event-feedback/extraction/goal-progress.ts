import type { FeedbackConversationGoal } from "../../conversations/feedback-conversation.schemas.js";
import type {
  FeedbackExtractionContext,
  ValidatedFeedbackExtraction,
} from "../post-event-feedback-extraction.schemas.js";

export interface GoalStatusUpdate {
  readonly key: FeedbackConversationGoal["key"];
  readonly status: FeedbackConversationGoal["status"];
}

/**
 * Answered wins over everything, including a skip proposed in the same run.
 * Goals answered in an earlier run are re-derived rather than remembered, so a
 * replay that finds its answers already stored still repairs the statuses.
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
  // The next question is only "asked" once an outbound actually carries it.
  if (
    validated.nextGoal &&
    validated.reply &&
    !updates.has(validated.nextGoal)
  ) {
    updates.set(validated.nextGoal, {
      key: validated.nextGoal,
      status: "asked",
    });
  }

  return [...updates.values()];
}

export function isCompleting(
  goals: readonly FeedbackConversationGoal[],
  updates: readonly GoalStatusUpdate[],
): boolean {
  const byKey = new Map(updates.map((update) => [update.key, update.status]));
  return goals.every((goal) => {
    const status = byKey.get(goal.key) ?? goal.status;
    return status === "answered" || status === "skipped";
  });
}
