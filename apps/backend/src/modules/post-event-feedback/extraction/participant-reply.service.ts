import { Injectable } from "@nestjs/common";

import { latestParticipantMessage } from "../conversation-reader.js";
import {
  FeedbackLogger,
  FeedbackOperationLog,
} from "../feedback-operation-log.js";
import { PostEventFeedbackMetrics } from "../metrics.service.js";
import { resolveGoalStatuses } from "./goal-progress.js";
import { createFeedbackClosingDedupeKey } from "./extraction.schemas.js";
import { FeedbackConversationExecutionGuardError } from "./execution-guard.js";
import { FeedbackExtractionGuards } from "./extraction-guards.service.js";
import type {
  ExtractPlannedTurn,
  ExtractRunSnapshot,
} from "./extract.types.js";
import {
  combineFeedbackExtractionUsage,
  PostEventFeedbackExtractionModel,
  type FeedbackReplyGenerationResult,
} from "../../../integrations/llm/feedback-extraction-model.service.js";
import {
  countsAsHostileTurn,
  stopsForHostility,
} from "./operator-attention.js";
import {
  resolveOutbound,
  withCampaignReaskCap,
  withPolicyAnswers,
  withSafetyAssurance,
} from "./outbound-reply.js";
import { isUnansweredPolicyQuestion } from "./policy-answers.js";
import {
  decideExtractionTurn,
  deriveTurnPolicyFacts,
  suppressCloseAfterInitialWithholding,
} from "./turn-decision.js";
import {
  extractionTurnLogContext,
  type AnalyzedModelTurn,
  type PreparedModelContext,
} from "./turn-planning.types.js";

/**
 * Chooses participant-facing copy, may rewrite it, then reviews live state
 * before enqueue. Persistence and later commit suppression stay elsewhere.
 */
@Injectable()
export class FeedbackParticipantReplyPlanner {
  private readonly logger = new FeedbackLogger(
    FeedbackParticipantReplyPlanner.name,
  );

  constructor(
    private readonly generation: PostEventFeedbackExtractionModel,
    private readonly metrics: PostEventFeedbackMetrics,
    private readonly guards: FeedbackExtractionGuards,
  ) {}

  async plan(
    snapshot: ExtractRunSnapshot,
    prepared: PreparedModelContext,
    analyzed: AnalyzedModelTurn,
  ): Promise<ExtractPlannedTurn> {
    const { conversation, cursorSeq } = snapshot;
    let validated = analyzed.validated;
    const recordedStatuses = resolveGoalStatuses(
      conversation.goals,
      prepared.context,
      validated,
    );
    const hostileTurn = countsAsHostileTurn({
      hostileMessageIds: analyzed.attention.hostileMessageIds,
      safetySignalCount: validated.safetySignals.length,
    });
    const hostileTurns = conversation.hostileTurns + (hostileTurn ? 1 : 0);
    const stoppingForHostility = stopsForHostility({
      hostileTurn,
      hostileTurns,
      safetySignalCount: validated.safetySignals.length,
    });
    const facts = deriveTurnPolicyFacts({
      conversation,
      validated,
      recordedStatuses,
      hostileTurn,
      stoppingForHostility,
    });
    const testimonySeq =
      latestParticipantMessage(conversation)?.seq ?? cursorSeq;
    let resolvedOutbound = resolveOutbound(
      conversation,
      validated,
      facts.progressClosing,
      facts.urgentSafety,
      testimonySeq,
      prepared.copy,
      recordedStatuses,
      stoppingForHostility,
    );

    const runUsages = [...analyzed.runUsages];
    let replyRewriteSuperseded = false;
    if (resolvedOutbound?.generatedByModel && validated.reply) {
      try {
        const rewritten = await this.rewriteReply(
          snapshot,
          prepared,
          validated.reply,
        );
        runUsages.push(rewritten.usage);
        this.metrics.recordExtractTokens(
          {
            phase: "feedback_reply",
            model: rewritten.model,
            estimatedPromptTokens: rewritten.estimatedPromptTokens,
            inputTokens: rewritten.usage.inputTokens,
            outputTokens: rewritten.usage.outputTokens,
            totalTokens: rewritten.usage.totalTokens,
          },
          snapshot.correlationId,
        );
        if (rewritten.reply === null) {
          resolvedOutbound = undefined;
          this.logger.warn({
            event: "feedback.extract.reply_withheld",
            correlationId: snapshot.correlationId,
            conversationId: conversation._id,
            reason: "reply_generation_failed",
          });
        } else {
          validated = { ...validated, reply: rewritten.reply };
          resolvedOutbound = resolveOutbound(
            conversation,
            validated,
            facts.progressClosing,
            facts.urgentSafety,
            testimonySeq,
            prepared.copy,
            recordedStatuses,
            stoppingForHostility,
          );
        }
      } catch (error) {
        if (
          error instanceof FeedbackConversationExecutionGuardError &&
          error.reason === "authoritative_state_changed"
        ) {
          replyRewriteSuperseded = true;
          resolvedOutbound = undefined;
          this.logger.log({
            event: "feedback.extract.reply_withheld",
            correlationId: snapshot.correlationId,
            conversationId: conversation._id,
            reason: "authoritative_state_changed_before_reply_rewrite",
          });
        } else {
          throw error;
        }
      }
    }

    const runUsage = combineFeedbackExtractionUsage(runUsages);
    const capped = withCampaignReaskCap(
      conversation,
      resolvedOutbound,
      prepared.copy,
    );
    const outbound = withSafetyAssurance(
      conversation,
      validated,
      withPolicyAnswers(
        conversation,
        capped.outbound,
        analyzed.attention.policyQuestions,
      ),
      new Set(analyzed.attention.describedIncidentMessageIds),
    );
    const unansweredDataQuestionMessageIds = [
      ...new Set(
        analyzed.attention.policyQuestions
          .filter((match) => isUnansweredPolicyQuestion(match.question))
          .map((match) => match.messageId),
      ),
    ];
    const withheld = outbound
      ? await this.guards.reviewBeforeEnqueue({
          conversation,
          cursorSeq,
          staleOnNewerTestimony: facts.ordinaryReply || facts.progressClosing,
          executionClaim: snapshot.executionClaim,
        })
      : undefined;
    if (withheld) {
      this.logger.log({
        event: "feedback.extract.outbound_withheld",
        correlationId: snapshot.correlationId,
        conversationId: conversation._id,
        cursorSeq,
        reason: withheld,
      });
    }

    const outboundIntent = withheld ? undefined : outbound;
    const decided = decideExtractionTurn({
      conversation,
      validated,
      recordedStatuses,
      askedGoal: outboundIntent?.askedGoal,
      hasOutboundIntent: outboundIntent !== undefined,
      hostileTurn,
      stoppingForHostility,
    });
    // Initial withhold / rewrite supersession can drop close; commit
    // suppression of a later intent is a different rule.
    const closingReason = suppressCloseAfterInitialWithholding({
      progressClosing: facts.progressClosing,
      withheld: withheld !== undefined,
      rewriteSuperseded: replyRewriteSuperseded,
      closingReason: decided.closingReason,
    });
    const outboundForPersistence =
      closingReason !== null && outboundIntent
        ? {
            ...outboundIntent,
            dedupeKey: createFeedbackClosingDedupeKey(
              conversation._id,
              testimonySeq,
              snapshot.executionClaim.workRevision,
            ),
          }
        : outboundIntent;

    return {
      evidence: {
        context: prepared.context,
        validated,
        recordedStatuses,
        hostileTurn,
        stoppingForHostility,
        rewriteSuperseded: replyRewriteSuperseded,
        stalledOnMessageId: capped.stalledOnMessageId,
        unansweredDataQuestionMessageIds,
        newestParticipantMessageId:
          prepared.context.newParticipantMessageIds.at(-1) ?? null,
        runUsage,
        model: analyzed.generated.model,
        serviceTier: this.generation.serviceTier ?? null,
      },
      proposed: {
        goalStatuses: decided.goalStatuses,
        withdrew: decided.withdrew,
        hostility: decided.hostility,
        closingReason,
        outboundIntent: outboundForPersistence,
      },
    };
  }

  private async rewriteReply(
    snapshot: ExtractRunSnapshot,
    prepared: PreparedModelContext,
    draft: string,
  ): Promise<FeedbackReplyGenerationResult> {
    const child = new FeedbackOperationLog(this.logger, {
      operation: "extract_rewrite",
      ...extractionTurnLogContext(snapshot),
    });
    child.stage("rewrite");
    try {
      const rewritten = await this.generation.rewriteReply(
        prepared.prompt,
        draft,
        prepared.beforeProviderCall,
      );
      child.complete("rewritten");
      return rewritten;
    } catch (error) {
      if (
        error instanceof FeedbackConversationExecutionGuardError &&
        error.reason === "authoritative_state_changed"
      ) {
        child.failed(error, "superseded");
      } else {
        child.failed(error);
      }
      throw error;
    }
  }
}
