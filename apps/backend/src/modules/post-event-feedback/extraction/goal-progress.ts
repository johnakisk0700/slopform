import type { FeedbackAnswerQuestionKey } from "@slopform/database";

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
 * Answered wins, including over a skip in the same run. Earlier answers are
 * re-derived so a replay still repairs statuses.
 *
 * Do not mark `asked` here: the model's `nextGoal` is a wish until validation
 * and outbound agree. Apply `asked` from the outbound that actually poses the
 * question.
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
 * Earliest still-open goal after this run's recorded updates, in questionnaire
 * order. Completion and re-ask both use this — never the model's private ladder.
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
 * Goals that owe nothing after this run's recorded updates (answered or
 * skipped). The campaign re-ask must not restate a settled goal when a surplus
 * mention fails to resolve.
 */
export function settledGoalKeys(
  goals: readonly FeedbackConversationGoal[],
  updates: readonly GoalStatusUpdate[],
): ReadonlySet<FeedbackAnswerQuestionKey> {
  const byKey = new Map(updates.map((update) => [update.key, update.status]));
  const settled = new Set<FeedbackAnswerQuestionKey>();
  for (const goal of goals) {
    const status = byKey.get(goal.key) ?? goal.status;
    if (status === "answered" || status === "skipped") {
      settled.add(goal.key);
    }
  }
  return settled;
}

/**
 * Marks the goal this outbound is actually asking.
 *
 * Answered never demotes (D16). A skipped goal that this send re-opens as a
 * hold question must return to `asked`, or `isCompleting` is true under a live
 * question and the confirmation lands as `post_closure_message`.
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
      (update) => update.key === askedGoal && update.status === "answered",
    )
  ) {
    return [...updates];
  }
  const without = updates.filter((update) => update.key !== askedGoal);
  return [...without, { key: askedGoal, status: "asked" }];
}

/**
 * Withdrawal: skip remaining open goals so reminders stop, but do not close.
 * `closingNow` excludes this path — the bot gave up; a person should read it.
 * Answered and already-skipped stay as they are.
 */
export function withSettledOpenGoals(
  goals: readonly FeedbackConversationGoal[],
  updates: readonly GoalStatusUpdate[],
): GoalStatusUpdate[] {
  const byKey = new Map(updates.map((update) => [update.key, update]));
  for (const goal of goals) {
    const status = byKey.get(goal.key)?.status ?? goal.status;
    if (status === "answered" || status === "skipped") {
      continue;
    }
    byKey.set(goal.key, { key: goal.key, status: "skipped" });
  }
  return [...byKey.values()];
}

/**
 * Withdrawal: nothing recorded, a pre-enqueue outbound intent exists, no
 * question posed, but the model still named a `nextGoal`. A `nextGoal: null`
 * side-question reply must not settle the ladder. `already_recorded` refusals
 * mean replay repair, not withdrawal — otherwise a replayed acknowledgement
 * would close mid-ladder.
 */
export function isWithdrawal(input: {
  readonly answers: { readonly length: number };
  readonly notes: { readonly length: number };
  readonly nextGoal: FeedbackAnswerQuestionKey | null;
  readonly askedGoal: FeedbackAnswerQuestionKey | undefined;
  readonly hasOutboundIntent: boolean;
  readonly repairingStoredResults?: boolean;
}): boolean {
  return (
    input.hasOutboundIntent &&
    input.answers.length === 0 &&
    input.notes.length === 0 &&
    input.nextGoal !== null &&
    input.askedGoal === undefined &&
    !input.repairingStoredResults
  );
}

export function isCompleting(
  goals: readonly FeedbackConversationGoal[],
  updates: readonly GoalStatusUpdate[],
): boolean {
  return nextOpenGoal(goals, updates) === null;
}
