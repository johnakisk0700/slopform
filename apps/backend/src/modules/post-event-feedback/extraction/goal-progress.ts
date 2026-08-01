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
 * The goals that owe nothing once this run's recorded updates apply — answered
 * earlier, answered by an answer that survived validation just now, or skipped.
 *
 * The campaign re-ask reads this before repeating a question. A refused
 * *surplus* mention on a goal that already holds its answer is not a question
 * the participant still owes us anything on: in the 2026-08-01 paid rehearsal,
 * Ρούλα Κομποσερίδου had `liked` answered (η Λούλα) and kept mentioning table
 * neighbours who resolved to nobody, and every unresolved name re-sent the
 * `liked` campaign copy to a question she had answered two turns earlier.
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
 * Records that the outbound this run is about to send is asking a particular
 * goal.
 *
 * An answered goal stays answered — re-asking something already recorded is
 * the wrong behaviour, and D16 forbids demoting it. A skipped goal is
 * different: prompt rule 9δ banks a skip and then poses a hold question about
 * the same goal on purpose («θέλεις τελικά να σημειώσουμε τον Κώστα ή να
 * μείνει το "κανέναν";»). Leaving it skipped makes `isCompleting` true under
 * that live question, so the thanks-only turn that follows closes the
 * conversation and the confirmation arrives as `post_closure_message`. The
 * bot re-opened the decision; the ladder must show `asked` again.
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
 * A run that wrote nothing and asked nothing is a withdrawal: the bot decided
 * to stop. Without this, remaining goals stay pending/asked, the reminder
 * ladder keeps chasing, and the conversation only dies at expiry — days after
 * the participant was told the bot was backing off. Settled goals stop the
 * reminder ladder chasing a questionnaire the bot has abandoned; they
 * deliberately do **not** close it — `closingNow` excludes a withdrawal on
 * purpose, because here the bot gave up rather than the participant, and the
 * conversation goes to a person instead.
 *
 * Answered wins; an already-skipped goal stays skipped. Only open goals
 * (pending or asked, including ones not yet in the update list) become skipped.
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
 * No accepted answers, no accepted notes, and the outbound that will actually
 * go out does not pose a question — while the model still named a `nextGoal`.
 * That is a withdrawal: it claimed the ladder continued and then wrote a
 * statement («το bot αποσύρεται…»). A bare `nextGoal: null` reply with nothing
 * to extract is how the bot answers a side question (flirting, "who reads
 * this") without ending the questionnaire, and must not settle the ladder.
 *
 * A replay of a finished write looks the same on the accepted lists (validation
 * refuses the duplicates as `already_recorded`), so those refusals are the
 * signal that this run is repairing, not bowing out — without them a replayed
 * «Τέλεια, το σημείωσα!» would settle the ladder and close mid-questionnaire.
 */
export function isWithdrawal(input: {
  readonly answers: { readonly length: number };
  readonly notes: { readonly length: number };
  readonly nextGoal: FeedbackAnswerQuestionKey | null;
  readonly askedGoal: FeedbackAnswerQuestionKey | undefined;
  readonly outboundSent: boolean;
  readonly repairingStoredResults?: boolean;
}): boolean {
  return (
    input.outboundSent &&
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
