import { Injectable } from "@nestjs/common";

import { DatabaseService } from "../../../infrastructure/database/database.service.js";
import { FeedbackConversationRepository } from "../post-event-feedback-conversation.repository.js";
import { FeedbackOutboxRepository } from "../outbox/outbox.repository.js";
import {
  FeedbackLogger,
  FeedbackOperationLog,
} from "../feedback-operation-log.js";
import { skipExtractOutcome } from "./extract-admission.js";
import {
  PostEventFeedbackConversationNotFoundError,
  type ExtractFeedbackResult,
  type ExtractRunSnapshot,
} from "./extract.types.js";
import {
  FeedbackConversationExecutionGuardError,
  executionSnapshotGuardReason,
} from "./execution-guard.js";
import { FeedbackConversationExecutionFence } from "./execution-fence.service.js";
import { FeedbackResultsRepository } from "./results.repository.js";

/**
 * After a persist transaction rejects on transcript capacity, the paid
 * snapshot is gone. Park the bot so reconcile cannot buy another model
 * call for a metadata write that cannot succeed.
 *
 * Own transaction after that rollback. Re-check ownership under the
 * conversation lock so newer work or control changes win.
 */
@Injectable()
export class FeedbackExtractionCapacityService {
  private readonly logger = new FeedbackLogger(
    FeedbackExtractionCapacityService.name,
  );

  constructor(
    private readonly database: DatabaseService,
    private readonly results: FeedbackResultsRepository,
    private readonly executionFence: FeedbackConversationExecutionFence,
    private readonly conversations: FeedbackConversationRepository,
    private readonly outbox: FeedbackOutboxRepository,
  ) {}

  async brakeAfterCapacity(
    snapshot: ExtractRunSnapshot,
  ): Promise<ExtractFeedbackResult> {
    const conversation = snapshot.conversation;
    const operation = new FeedbackOperationLog(this.logger, {
      operation: "extract_capacity_brake",
      correlationId: snapshot.correlationId,
      conversationId: conversation._id,
      campaignId: snapshot.campaign.id,
      ...(snapshot.executionClaim
        ? {
            workRevision: snapshot.executionClaim.workRevision,
            executionEpoch: snapshot.executionClaim.epoch,
          }
        : {}),
    });
    this.logger.warn({
      event: "feedback.extract.transcript_capacity",
      correlationId: snapshot.correlationId,
      conversationId: conversation._id,
    });

    try {
      operation.stage("begin_transaction");
      const outcome = await this.database.transaction(async (transaction) => {
        operation.stage("reload");
        await this.results.lockConversation(transaction, conversation._id);

        operation.stage("fence");
        if (snapshot.executionClaim) {
          if (
            !(await this.executionFence.renewWithin(
              transaction,
              snapshot.executionClaim,
            ))
          ) {
            throw new FeedbackConversationExecutionGuardError(
              conversation._id,
              "execution_claim_lost",
            );
          }
        }

        // Campaign resume updates these rows without the conversation mutex.
        const current = await this.conversations.findByIdForUpdate(
          transaction,
          conversation._id,
        );
        if (snapshot.executionClaim) {
          const guardReason = executionSnapshotGuardReason(
            current,
            conversation,
            snapshot.executionClaim,
          );
          if (guardReason) {
            throw new FeedbackConversationExecutionGuardError(
              conversation._id,
              guardReason,
            );
          }
        } else {
          if (!current) {
            throw new PostEventFeedbackConversationNotFoundError(
              conversation._id,
            );
          }
          const skipped = skipExtractOutcome(current, current.messages.length);
          if (
            skipped === "skipped_closed" ||
            skipped === "skipped_human_control" ||
            skipped === "skipped_awaiting_human"
          ) {
            operation.stage("commit_transaction");
            return skipped;
          }
          if (
            (current.work?.revision ?? 0) !==
              (conversation.work?.revision ?? 0) ||
            current.control.changedAt.getTime() !==
              conversation.control.changedAt.getTime()
          ) {
            throw new FeedbackConversationExecutionGuardError(
              conversation._id,
              "authoritative_state_changed",
            );
          }
        }

        operation.stage("brake");
        const at = new Date();
        await this.conversations.raiseAttention(transaction, {
          conversationId: conversation._id,
          kind: "transcript_full",
          messageId: null,
          at,
        });
        await this.conversations.markAwaitingHuman(transaction, {
          conversationId: conversation._id,
          at,
        });
        await this.outbox.cancelQueuedAutomatedOutboxForConversation(
          transaction,
          conversation._id,
        );
        operation.stage("commit_transaction");
        return "skipped_awaiting_human" as const;
      });

      operation.complete(outcome);
      return {
        outcome,
        conversationId: conversation._id,
        cursorSeq: conversation.extraction.cursorSeq,
        answersWritten: 0,
        notesWritten: 0,
      };
    } catch (error) {
      if (
        error instanceof FeedbackConversationExecutionGuardError &&
        error.reason === "authoritative_state_changed"
      ) {
        operation.failed(error, "superseded");
      } else {
        operation.failed(error);
      }
      throw error;
    }
  }
}
