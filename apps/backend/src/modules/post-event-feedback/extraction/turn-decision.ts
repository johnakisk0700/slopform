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

/** Resolves goals and terminal intent from an admitted extraction proposal. */
export function decideExtractionTurn(input: {
  readonly conversation: FeedbackConversationDocument;
  readonly validated: FeedbackExtractionValidationResult;
  readonly recordedStatuses: readonly GoalStatusUpdate[];
  readonly askedGoal: GoalStatusUpdate["key"] | undefined;
  readonly outboundSent: boolean;
  readonly dutyOfCare: boolean;
  readonly stoppingForHostility: boolean;
  readonly hostileWithoutAnswers: boolean;
}): {
  readonly goalStatuses: GoalStatusUpdate[];
  readonly withdrew: boolean;
  readonly hostility: FeedbackHostilityRaise;
  readonly closingReason: "completed" | "declined" | null;
} {
  let goalStatuses = withAskedGoal(input.recordedStatuses, input.askedGoal);
  const withdrew =
    !input.dutyOfCare &&
    !input.stoppingForHostility &&
    input.validated.safetySignals.length === 0 &&
    isWithdrawal({
      answers: input.validated.answers,
      notes: input.validated.notes,
      nextGoal: input.validated.nextGoal,
      askedGoal: input.askedGoal,
      outboundSent: input.outboundSent,
      repairingStoredResults: input.validated.rejections.some(
        (rejection) => rejection.reason === "already_recorded",
      ),
    });
  if (withdrew) {
    goalStatuses = withSettledOpenGoals(input.conversation.goals, goalStatuses);
  }
  const hostility: FeedbackHostilityRaise = input.stoppingForHostility
    ? "stopped"
    : input.hostileWithoutAnswers &&
        isCompleting(input.conversation.goals, goalStatuses)
      ? "unanswerable"
      : "none";
  const closingNow =
    isCompleting(input.conversation.goals, goalStatuses) &&
    input.validated.safetySignals.length === 0 &&
    !input.dutyOfCare &&
    !withdrew &&
    !input.stoppingForHostility &&
    !input.hostileWithoutAnswers;
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
