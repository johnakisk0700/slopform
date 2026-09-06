import { Injectable } from "@nestjs/common";
import type { FeedbackExtractionStateApplyInput } from "./extraction-commit.types.js";
import type { AppTransaction } from "@slopform/database";

import { FeedbackConversationRepository } from "../post-event-feedback-conversation.repository.js";
import { FeedbackOutboxRepository } from "../outbox/outbox.repository.js";
import type { ExtractConversationState } from "./extract.types.js";
import {
  FeedbackConversationExecutionGuardError,
  executionSnapshotGuardReason,
} from "./execution-guard.js";
import {
  groupSafetySignalsByMessage,
  operatorAttentionRaises,
} from "./operator-attention.js";
import { FeedbackResultsRepository } from "./results.repository.js";

/**
 * Goals, attention, cursor, terminal close and handoff on the caller's
 * transaction. Starts no transaction. Operator alerts are returned for
 * the caller to fire after commit.
 */
@Injectable()
export class FeedbackExtractionStateApplier {
  constructor(
    private readonly results: FeedbackResultsRepository,
    private readonly conversations: FeedbackConversationRepository,
    private readonly outbox: FeedbackOutboxRepository,
  ) {}

  async apply(
    transaction: AppTransaction,
    input: FeedbackExtractionStateApplyInput,
  ): Promise<ExtractConversationState> {
    const at = new Date();

    if (input.goalStatuses.length > 0) {
      await this.conversations.updateGoalStatuses(transaction, {
        conversationId: input.conversation._id,
        statuses: input.goalStatuses,
        at,
      });
    }

    for (const attention of groupSafetySignalsByMessage(
      input.validated.safetySignals,
    )) {
      await this.conversations.mergeMessageAttention(transaction, {
        conversationId: input.conversation._id,
        messageId: attention.messageId,
        categories: attention.categories,
        recommendedAction: attention.recommendedAction,
        confidence: attention.confidence,
        at,
      });
    }

    if (input.hostileTurn) {
      await this.conversations.recordHostileTurn(transaction, {
        conversationId: input.conversation._id,
        at,
        expectedCount: input.priorHostileTurns,
      });
    }

    const raises = operatorAttentionRaises(
      input.validated,
      input.newestParticipantMessageId,
      input.withdrew,
      input.hostility,
      input.stalledOnMessageId,
      input.unansweredDataQuestionMessageIds,
    );
    let raisedIncident = false;
    for (const raise of raises) {
      const attention = await this.conversations.raiseAttention(transaction, {
        conversationId: input.conversation._id,
        kind: raise.kind,
        messageId: raise.messageId,
        at,
      });
      raisedIncident ||=
        attention.changed &&
        (raise.kind === "safety" || raise.kind === "handoff");
    }

    if (input.workSuperseded) {
      return { closedNow: false, terminalCommitted: false, raisedIncident };
    }

    if (input.closingReason) {
      const closingReason = input.closingReason;
      await this.results.lockConversation(transaction, input.conversation._id);
      const transition = await this.conversations.advanceCursorAndClose(
        transaction,
        {
          conversationId: input.conversation._id,
          toSeq: input.cursorSeq,
          reason: closingReason,
          terminalOutboxId: input.terminalOutboxId,
          at,
          model: input.model,
          serviceTier: input.serviceTier,
          usage: input.usage,
          ...(input.executionClaim
            ? {
                workRevision: input.executionClaim.workRevision,
                executionEpoch: input.executionClaim.epoch,
              }
            : {}),
        },
      );
      const committed =
        transition.changed ||
        (transition.conversation.lifecycle.state === "closed" &&
          transition.conversation.lifecycle.reason === closingReason &&
          transition.conversation.lifecycle.terminalOutboxId ===
            input.terminalOutboxId);
      if (committed) {
        await this.outbox.cancelQueuedOutboxForConversationExceptId(
          transaction,
          input.conversation._id,
          input.terminalOutboxId,
        );
      }
      if (transition.changed) {
        return { closedNow: true, terminalCommitted: true, raisedIncident };
      }
      if (committed) {
        return { closedNow: false, terminalCommitted: true, raisedIncident };
      }

      if (
        transition.conversation.messages.some(
          (message) =>
            message.actor === "participant" && message.seq > input.cursorSeq,
        )
      ) {
        await this.conversations.advanceCursor(transaction, {
          conversationId: input.conversation._id,
          toSeq: input.cursorSeq,
          at,
          model: input.model,
          serviceTier: input.serviceTier,
          usage: input.usage,
        });
      }
      return { closedNow: false, terminalCommitted: false, raisedIncident };
    }

    if (input.awaitingHuman) {
      await this.results.lockConversation(transaction, input.conversation._id);
      const transition =
        await this.conversations.advanceCursorAndMarkAwaitingHuman(
          transaction,
          {
            conversationId: input.conversation._id,
            toSeq: input.cursorSeq,
            at,
            model: input.model,
            serviceTier: input.serviceTier,
            usage: input.usage,
            ...(input.executionClaim
              ? {
                  workRevision: input.executionClaim.workRevision,
                  executionEpoch: input.executionClaim.epoch,
                }
              : {}),
          },
        );
      const committed =
        transition.changed || transition.conversation.awaitingHuman;
      await this.outbox.cancelQueuedAutomatedOutboxForConversation(
        transaction,
        input.conversation._id,
        committed ? input.handoffOutboxId : null,
      );
      if (!committed) {
        const guardReason = input.executionClaim
          ? (executionSnapshotGuardReason(
              transition.conversation,
              input.conversation,
              input.executionClaim,
            ) ?? "execution_invariant_broken")
          : "authoritative_state_changed";
        throw new FeedbackConversationExecutionGuardError(
          input.conversation._id,
          guardReason,
        );
      }
    } else {
      await this.conversations.advanceCursor(transaction, {
        conversationId: input.conversation._id,
        toSeq: input.cursorSeq,
        at,
        model: input.model,
        serviceTier: input.serviceTier,
        usage: input.usage,
        ...(input.executionClaim
          ? {
              workRevision: input.executionClaim.workRevision,
              executionEpoch: input.executionClaim.epoch,
            }
          : {}),
      });
    }

    return { closedNow: false, terminalCommitted: false, raisedIncident };
  }
}
