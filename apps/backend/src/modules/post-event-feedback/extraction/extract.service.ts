import { Inject, Injectable } from "@nestjs/common";

import {
  FEEDBACK_OPERATOR_ALERT,
  type FeedbackOperatorAlert,
} from "../operator-alert.js";
import { DatabaseService } from "../../../infrastructure/database/database.service.js";
import { FeedbackCampaignRepository } from "../campaign/campaign.repository.js";
import { FeedbackResultsRepository } from "./results.repository.js";
import {
  FeedbackConversationCapacityError,
  FeedbackConversationRepository,
} from "../post-event-feedback-conversation.repository.js";
import { ParticipantsRepository } from "../../participants/participants.repository.js";
import {
  FeedbackLogger,
  FeedbackOperationLog,
} from "../feedback-operation-log.js";
import { PostEventFeedbackMetrics } from "../metrics.service.js";
import { PostEventFeedbackCampaignSummaryService } from "../summary/summary.service.js";
import { FeedbackConversationExecutionFence } from "./execution-fence.service.js";
import { skipExtractOutcome } from "./extract-admission.js";
import { FeedbackConversationExecutionGuardError } from "./execution-guard.js";
import { FeedbackExtractionCommitService } from "./extraction-commit.service.js";
import { FeedbackExtractionTurnService } from "./extraction-turn.service.js";
import {
  PostEventFeedbackCampaignNotFoundError,
  PostEventFeedbackConversationNotFoundError,
  type ExtractAdmission,
  type ExtractCommitResult,
  type ExtractFeedbackInput,
  type ExtractFeedbackResult,
  type ExtractPlannedTurn,
  type ExtractRunSnapshot,
} from "./extract.types.js";

export {
  FEEDBACK_CONVERSATION_EXECUTION_GUARD_REASONS,
  FeedbackConversationExecutionGuardError,
  type FeedbackConversationExecutionGuardReason,
} from "./execution-guard.js";
export {
  PostEventFeedbackCampaignNotFoundError,
  PostEventFeedbackConversationNotFoundError,
  type ExtractFeedbackInput,
  type ExtractFeedbackResult,
} from "./extract.types.js";

/**
 * Admits a conversation for extraction, plans one AI turn, then commits
 * results, outbound intent and the consumed cursor under the execution fence.
 */
@Injectable()
export class PostEventFeedbackExtractor {
  private readonly logger = new FeedbackLogger(PostEventFeedbackExtractor.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly campaigns: FeedbackCampaignRepository,
    private readonly results: FeedbackResultsRepository,
    private readonly conversations: FeedbackConversationRepository,
    private readonly participants: ParticipantsRepository,
    private readonly executionFence: FeedbackConversationExecutionFence,
    private readonly turns: FeedbackExtractionTurnService,
    private readonly commits: FeedbackExtractionCommitService,
    private readonly metrics: PostEventFeedbackMetrics,
    @Inject(FEEDBACK_OPERATOR_ALERT)
    private readonly alert: FeedbackOperatorAlert,
    private readonly summaries: PostEventFeedbackCampaignSummaryService,
  ) {}

  async extract(input: ExtractFeedbackInput): Promise<ExtractFeedbackResult> {
    const operation = new FeedbackOperationLog(this.logger, {
      operation: "extract",
      correlationId: input.correlationId,
      conversationId: input.conversationId,
      ...(input.executionClaim
        ? {
            workRevision: input.executionClaim.workRevision,
            executionEpoch: input.executionClaim.epoch,
          }
        : {}),
    });
    try {
      const result = await this.runExtract(input, operation);
      operation.complete(result.outcome);
      return result;
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

  private async runExtract(
    input: ExtractFeedbackInput,
    operation: FeedbackOperationLog,
  ): Promise<ExtractFeedbackResult> {
    operation.stage("admit");
    const admitted = await this.admit(input);
    if (admitted.kind === "complete") {
      return admitted.result;
    }

    operation.enrich({
      campaignId: admitted.snapshot.campaign.id,
      conversationId: admitted.snapshot.conversation._id,
    });

    operation.stage("plan_turn");
    const turn = await this.turns.plan(admitted.snapshot);

    operation.stage("commit_turn");
    let committed: ExtractCommitResult;
    try {
      committed = await this.commits.commit(admitted.snapshot, turn);
    } catch (error) {
      if (!(error instanceof FeedbackConversationCapacityError)) {
        throw error;
      }
      operation.stage("capacity_brake");
      return this.complete(
        await this.commits.brakeAfterCapacity(admitted.snapshot),
        input.correlationId,
      );
    }

    if (committed.raisedIncident) {
      operation.stage("notify_operator");
      await this.alert.raise({
        conversationId: admitted.snapshot.conversation._id,
        campaignId: admitted.snapshot.conversation.campaignId,
        reason: "extraction_safety_signal",
        correlationId: input.correlationId,
        detail: [
          ...turn.evidence.validated.safetySignals.map(
            (signal) => `${signal.category}:${signal.recommendedAction}`,
          ),
          ...(turn.evidence.validated.handoff ? ["handoff"] : []),
        ],
      });
    }

    operation.stage("notify_summary");
    await this.summaries.notifyIfLastConversationClosed(
      admitted.snapshot.conversation.campaignId,
      input.correlationId,
      committed.state.closedNow,
    );

    operation.stage("record_outcome");
    return this.complete(
      toExtractResult(admitted.snapshot, turn, committed),
      input.correlationId,
    );
  }

  private async admit(input: ExtractFeedbackInput): Promise<ExtractAdmission> {
    const conversation = await this.conversations.findById(
      input.conversationId,
    );
    if (!conversation) {
      throw new PostEventFeedbackConversationNotFoundError(
        input.conversationId,
      );
    }

    const cursorSeq = conversation.messages.length;
    const skipped = skipExtractOutcome(conversation, cursorSeq);
    if (skipped) {
      return {
        kind: "complete",
        result: this.complete(
          {
            outcome: skipped,
            conversationId: conversation._id,
            cursorSeq: conversation.extraction.cursorSeq,
            answersWritten: 0,
            notesWritten: 0,
          },
          input.correlationId,
        ),
      };
    }

    const pending = conversation.messages.filter(
      (message) => message.seq > conversation.extraction.cursorSeq,
    );
    if (!pending.some((message) => message.actor === "participant")) {
      await this.advanceCursorWithoutTestimony(conversation, cursorSeq, input);
      return {
        kind: "complete",
        result: this.complete(
          {
            outcome: "skipped_no_new_testimony",
            conversationId: conversation._id,
            cursorSeq,
            answersWritten: 0,
            notesWritten: 0,
          },
          input.correlationId,
        ),
      };
    }

    const campaign = await this.campaigns.findCampaignById(
      conversation.campaignId,
    );
    if (!campaign) {
      throw new PostEventFeedbackCampaignNotFoundError(conversation.campaignId);
    }
    if (campaign.status !== "launched") {
      return {
        kind: "complete",
        result: this.complete(
          {
            outcome: "skipped_campaign_inactive",
            conversationId: conversation._id,
            cursorSeq: conversation.extraction.cursorSeq,
            answersWritten: 0,
            notesWritten: 0,
          },
          input.correlationId,
        ),
      };
    }
    const currentParticipant = await this.participants.findById(
      conversation.respondentParticipantId,
    );
    if (!currentParticipant?.postEventFeedbackWhatsappOptIn) {
      return {
        kind: "complete",
        result: this.complete(
          {
            outcome: "skipped_consent_withdrawn",
            conversationId: conversation._id,
            cursorSeq: conversation.extraction.cursorSeq,
            answersWritten: 0,
            notesWritten: 0,
          },
          input.correlationId,
        ),
      };
    }

    return {
      kind: "run",
      snapshot: {
        conversation,
        campaign,
        cursorSeq,
        correlationId: input.correlationId,
        ...(input.executionClaim
          ? { executionClaim: input.executionClaim }
          : {}),
      },
    };
  }

  /** No participant testimony: skip the model; still advance the cursor. */
  private async advanceCursorWithoutTestimony(
    conversation: ExtractRunSnapshot["conversation"],
    cursorSeq: number,
    input: ExtractFeedbackInput,
  ): Promise<void> {
    await this.database.transaction(async (transaction) => {
      await this.results.lockConversation(transaction, conversation._id);
      if (
        input.executionClaim &&
        !(await this.executionFence.isCurrent(
          transaction,
          input.executionClaim,
        ))
      ) {
        throw new FeedbackConversationExecutionGuardError(
          conversation._id,
          "execution_claim_lost",
        );
      }
      await this.conversations.advanceCursor(transaction, {
        conversationId: conversation._id,
        toSeq: cursorSeq,
        at: new Date(),
        model: conversation.extraction.model,
        // Carry prior model/tier. Omit `usage` — null would erase paid totals.
        serviceTier: conversation.extraction.serviceTier,
        ...(input.executionClaim
          ? {
              workRevision: input.executionClaim.workRevision,
              executionEpoch: input.executionClaim.epoch,
            }
          : {}),
      });
    });
  }

  private complete(
    result: ExtractFeedbackResult,
    correlationId: string,
  ): ExtractFeedbackResult {
    this.metrics.recordExtractOutcome(result.outcome, correlationId);
    return result;
  }
}

function toExtractResult(
  snapshot: ExtractRunSnapshot,
  turn: ExtractPlannedTurn,
  committed: ExtractCommitResult,
): ExtractFeedbackResult {
  return {
    outcome:
      committed.closingReason ??
      (turn.evidence.validated.handoff ? "handoff" : "extracted"),
    conversationId: snapshot.conversation._id,
    cursorSeq: snapshot.cursorSeq,
    answersWritten: committed.written.answersWritten,
    notesWritten: committed.written.notesWritten,
    ...(committed.effectiveOutbox
      ? { outboxId: committed.effectiveOutbox.id }
      : {}),
    model: turn.evidence.model,
  };
}
