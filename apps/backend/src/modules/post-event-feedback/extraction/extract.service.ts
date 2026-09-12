import { Inject, Injectable } from "@nestjs/common";

import {
  FeedbackLogger,
  FeedbackOperationLog,
} from "../feedback-operation-log.js";
import { PostEventFeedbackMetrics } from "../metrics.service.js";
import {
  FEEDBACK_OPERATOR_ALERT,
  type FeedbackOperatorAlert,
} from "../operator-alert.js";
import { FeedbackConversationCapacityError } from "../post-event-feedback-conversation.repository.js";
import { PostEventFeedbackCampaignSummaryService } from "../summary/summary.service.js";
import { FeedbackConversationExecutionGuardError } from "./execution-guard.js";
import type {
  ExtractCommitResult,
  ExtractFeedbackInput,
  ExtractFeedbackResult,
  ExtractPlannedTurn,
  ExtractRunSnapshot,
} from "./extract.types.js";
import { FeedbackExtractionAdmissionService } from "./extraction-admission.service.js";
import { FeedbackExtractionCapacityService } from "./extraction-capacity.service.js";
import { FeedbackExtractionCommitService } from "./extraction-commit.service.js";
import { FeedbackExtractionTurnService } from "./extraction-turn.service.js";

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

/** Admit one conversation, plan an AI turn, commit it, then notify observers. */
@Injectable()
export class PostEventFeedbackExtractor {
  private readonly logger = new FeedbackLogger(PostEventFeedbackExtractor.name);

  constructor(
    private readonly admission: FeedbackExtractionAdmissionService,
    private readonly turns: FeedbackExtractionTurnService,
    private readonly commits: FeedbackExtractionCommitService,
    private readonly capacity: FeedbackExtractionCapacityService,
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
      workRevision: input.executionClaim.workRevision,
      executionEpoch: input.executionClaim.epoch,
    });
    try {
      const result = await this.extractTurn(input, operation);
      this.metrics.recordExtractOutcome(result.outcome, input.correlationId);
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

  private async extractTurn(
    input: ExtractFeedbackInput,
    operation: FeedbackOperationLog,
  ): Promise<ExtractFeedbackResult> {
    // Skip paid AI work when there is no eligible, unread testimony.
    operation.stage("admit");
    const admitted = await this.admission.admit(input);
    if (admitted.kind === "complete") return admitted.result;
    const snapshot = admitted.snapshot;
    operation.enrich({
      campaignId: snapshot.campaign.id,
      conversationId: snapshot.conversation._id,
    });

    // Validate model claims against the snapshot and plan a participant reply.
    operation.stage("plan_turn");
    const turn = await this.turns.plan(snapshot);

    // Recheck live state under locks; save paid results and any eligible reply.
    operation.stage("commit_turn");
    let committed: ExtractCommitResult;
    try {
      committed = await this.commits.commit(snapshot, turn);
    } catch (error) {
      if (!(error instanceof FeedbackConversationCapacityError)) throw error;
      // Only a failed commit triggers this separate transaction after rollback.
      operation.stage("capacity_brake");
      return this.capacity.brakeAfterCapacity(snapshot);
    }

    // External notifications happen only after the main transaction succeeds.
    if (committed.raisedIncident) {
      operation.stage("notify_operator");
      await this.alert.raise({
        conversationId: snapshot.conversation._id,
        campaignId: snapshot.conversation.campaignId,
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
      snapshot.conversation.campaignId,
      input.correlationId,
      committed.state.closedNow,
    );

    operation.stage("record_outcome");
    return toExtractResult(snapshot, turn, committed);
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
