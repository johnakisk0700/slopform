import type { FeedbackConversationDocument } from "../post-event-feedback-conversation.document.js";
import type { FeedbackExtractionValidationResult } from "./validate-proposal.js";
import {
  isCompleting,
  isWithdrawal,
  withAskedGoal,
  withSettledOpenGoals,
  type GoalStatusUpdate,
} from "./goal-progress.js";
import { answeredAnything } from "./outbound-reply.js";
import type { FeedbackHostilityRaise } from "./operator-attention.js";

export type ExtractionClosingReason = "completed" | "declined" | null;

export interface TurnPolicyFacts {
  readonly urgentSafety: boolean;
  readonly dutyOfCare: boolean;
  readonly hostileWithoutAnswers: boolean;
  readonly progressClosing: boolean;
  readonly ordinaryReply: boolean;
}

export interface ExtractionTurnDecision {
  readonly goalStatuses: readonly GoalStatusUpdate[];
  readonly withdrew: boolean;
  readonly hostility: FeedbackHostilityRaise;
  readonly closingReason: ExtractionClosingReason;
}

/** Deterministic policy facts from snapshot evidence. Not a disposition. */
export function deriveTurnPolicyFacts(input: {
  readonly conversation: FeedbackConversationDocument;
  readonly validated: FeedbackExtractionValidationResult;
  readonly recordedStatuses: readonly GoalStatusUpdate[];
  readonly hostileTurn: boolean;
  readonly stoppingForHostility: boolean;
}): TurnPolicyFacts {
  const urgentSafety = input.validated.safetySignals.some(
    (signal) => signal.recommendedAction === "urgent_human_follow_up",
  );
  const dutyOfCare = input.validated.handoff || urgentSafety;
  const hostileWithoutAnswers =
    input.hostileTurn && !answeredAnything(input.conversation, input.validated);
  const progressClosing =
    isCompleting(input.conversation.goals, input.recordedStatuses) &&
    input.validated.safetySignals.length === 0 &&
    !hostileWithoutAnswers;
  const ordinaryReply =
    !progressClosing && !input.validated.handoff && !input.stoppingForHostility;
  return {
    urgentSafety,
    dutyOfCare,
    hostileWithoutAnswers,
    progressClosing,
    ordinaryReply,
  };
}

/** Resolves goals and terminal intent from an admitted extraction proposal. */
export function decideExtractionTurn(input: {
  readonly conversation: FeedbackConversationDocument;
  readonly validated: FeedbackExtractionValidationResult;
  readonly recordedStatuses: readonly GoalStatusUpdate[];
  readonly askedGoal: GoalStatusUpdate["key"] | undefined;
  readonly hasOutboundIntent: boolean;
  readonly hostileTurn: boolean;
  readonly stoppingForHostility: boolean;
}): ExtractionTurnDecision {
  const facts = deriveTurnPolicyFacts(input);
  let goalStatuses = withAskedGoal(input.recordedStatuses, input.askedGoal);
  const withdrew =
    !facts.dutyOfCare &&
    !input.stoppingForHostility &&
    input.validated.safetySignals.length === 0 &&
    isWithdrawal({
      answers: input.validated.answers,
      notes: input.validated.notes,
      nextGoal: input.validated.nextGoal,
      askedGoal: input.askedGoal,
      hasOutboundIntent: input.hasOutboundIntent,
      repairingStoredResults: input.validated.rejections.some(
        (rejection) => rejection.reason === "already_recorded",
      ),
    });
  if (withdrew) {
    goalStatuses = withSettledOpenGoals(input.conversation.goals, goalStatuses);
  }
  const hostility: FeedbackHostilityRaise = input.stoppingForHostility
    ? "stopped"
    : facts.hostileWithoutAnswers &&
        isCompleting(input.conversation.goals, goalStatuses)
      ? "unanswerable"
      : "none";
  const closingNow =
    isCompleting(input.conversation.goals, goalStatuses) &&
    input.validated.safetySignals.length === 0 &&
    !facts.dutyOfCare &&
    !withdrew &&
    !input.stoppingForHostility &&
    !facts.hostileWithoutAnswers;
  return {
    goalStatuses,
    withdrew,
    hostility,
    closingReason: closingNow
      ? answeredAnything(input.conversation, input.validated)
        ? "completed"
        : "declined"
      : null,
  };
}

/**
 * Initial close suppression only. A missing candidate is not this rule —
 * no-intent-but-close still closes.
 */
export function suppressCloseAfterInitialWithholding(input: {
  readonly progressClosing: boolean;
  readonly withheld: boolean;
  readonly rewriteSuperseded: boolean;
  readonly closingReason: ExtractionClosingReason;
}): ExtractionClosingReason {
  if ((input.progressClosing && input.withheld) || input.rewriteSuperseded) {
    return null;
  }
  return input.closingReason;
}

/**
 * Ingress or newer-work adjustment: recompute without intent, then
 * prior close ? null : recomputed close. Not the initial-withholding rule.
 */
export function adjustAfterIngressOrWorkSuppression(
  prior: ExtractionTurnDecision,
  recomputed: ExtractionTurnDecision,
): ExtractionTurnDecision {
  return {
    goalStatuses: recomputed.goalStatuses,
    withdrew: recomputed.withdrew,
    hostility: recomputed.hostility,
    closingReason: prior.closingReason ? null : recomputed.closingReason,
  };
}
