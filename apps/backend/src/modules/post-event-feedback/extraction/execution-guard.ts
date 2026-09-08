import type { FeedbackConversationDocument } from "../post-event-feedback-conversation.document.js";
import { FeedbackProviderCallGuardError } from "../../../integrations/llm/feedback-extraction-model.service.js";
import type { FeedbackConversationExecutionClaim } from "./execution-fence.repository.js";

export const FEEDBACK_CONVERSATION_EXECUTION_GUARD_REASONS = [
  "authoritative_state_changed",
  "execution_claim_lost",
  "execution_invariant_broken",
] as const;

export type FeedbackConversationExecutionGuardReason =
  (typeof FEEDBACK_CONVERSATION_EXECUTION_GUARD_REASONS)[number];

/**
 * Stops one provider/effects boundary without laundering orchestration state
 * into a model-generation failure.
 *
 * The queue adapter decides terminal behavior from `reason`: an ordinary state
 * change is a successful supersession, a lost lease remains retryable, and a
 * missing or inconsistent execution projection is quarantined as unrecoverable.
 */
export class FeedbackConversationExecutionGuardError extends FeedbackProviderCallGuardError {
  constructor(
    conversationId: string,
    readonly reason: FeedbackConversationExecutionGuardReason,
  ) {
    super(`Feedback execution guard rejected ${conversationId}: ${reason}`);
    this.name = FeedbackConversationExecutionGuardError.name;
  }
}

/** Classifies the conversation half of one PostgreSQL execution claim. */
export function executionSnapshotGuardReason(
  current: FeedbackConversationDocument | undefined,
  snapshot: FeedbackConversationDocument,
  claim: FeedbackConversationExecutionClaim,
): FeedbackConversationExecutionGuardReason | undefined {
  if (
    claim.conversationId !== snapshot._id ||
    !snapshot.work ||
    !current ||
    !current.work
  ) {
    return "execution_invariant_broken";
  }

  if (current.work.executionEpoch > claim.epoch) {
    return "execution_claim_lost";
  }
  if (current.work.executionEpoch < claim.epoch) {
    return "execution_invariant_broken";
  }
  if (current.work.revision > claim.workRevision) {
    return "authoritative_state_changed";
  }
  if (current.work.revision < claim.workRevision) {
    return "execution_invariant_broken";
  }
  if (
    current.lifecycle.state !== "open" ||
    current.control.mode !== "bot" ||
    current.awaitingHuman ||
    current.control.changedAt.getTime() !== snapshot.control.changedAt.getTime()
  ) {
    return "authoritative_state_changed";
  }
  return undefined;
}
