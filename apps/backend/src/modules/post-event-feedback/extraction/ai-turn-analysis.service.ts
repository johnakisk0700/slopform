import { Injectable } from "@nestjs/common";
import type { FeedbackAnswerQuestionKey } from "@slopform/database";

import {
  FeedbackLogger,
  FeedbackOperationLog,
} from "../feedback-operation-log.js";
import { PostEventFeedbackMetrics } from "../metrics.service.js";
import type { ExtractRunSnapshot } from "./extract.types.js";
import {
  FeedbackExtractionGenerationError,
  PostEventFeedbackExtractionModel,
  type FeedbackAttentionClassificationGenerationResult,
  type FeedbackExtractionGenerationResult,
} from "../../../integrations/llm/feedback-extraction-model.service.js";
import {
  extractionTurnLogContext,
  type AnalyzedModelTurn,
  type PreparedModelContext,
} from "./turn-planning.types.js";
import { validateFeedbackExtractionProposal } from "./validate-proposal.js";

/**
 * Generates propose+classify output and validates model claims, citations,
 * and questions. Does not decide whether current conversation state may
 * be committed.
 */
@Injectable()
export class FeedbackAiTurnAnalysis {
  private readonly logger = new FeedbackLogger(FeedbackAiTurnAnalysis.name);

  constructor(
    private readonly generation: PostEventFeedbackExtractionModel,
    private readonly metrics: PostEventFeedbackMetrics,
  ) {}

  async analyze(
    snapshot: ExtractRunSnapshot,
    prepared: PreparedModelContext,
  ): Promise<AnalyzedModelTurn> {
    const questionKeys = prepared.context.goals.map((goal) => goal.key);
    // Both paid calls start together. The first rejection fails this step;
    // the sibling is not cancelled.
    const [generated, attention] = await Promise.all([
      this.proposeExtraction(snapshot, prepared, questionKeys),
      this.classifyAttention(snapshot, prepared),
    ]);
    this.metrics.recordExtractTokens(
      {
        phase: "feedback_extraction",
        model: generated.model,
        estimatedPromptTokens: prepared.estimatedPromptTokens,
        inputTokens: generated.usage.inputTokens,
        outputTokens: generated.usage.outputTokens,
        totalTokens: generated.usage.totalTokens,
      },
      snapshot.correlationId,
    );
    this.metrics.recordExtractTokens(
      {
        phase: "attention_classification",
        model: attention.model,
        estimatedPromptTokens: attention.estimatedPromptTokens,
        inputTokens: attention.usage.inputTokens,
        outputTokens: attention.usage.outputTokens,
        totalTokens: attention.usage.totalTokens,
      },
      snapshot.correlationId,
    );

    const validated = validateFeedbackExtractionProposal(
      generated.proposal,
      prepared.context,
      attention.signals,
    );
    if (validated.rejections.length > 0) {
      this.logger.warn({
        event: "feedback.extract.rejected_proposals",
        correlationId: snapshot.correlationId,
        conversationId: snapshot.conversation._id,
        rejections: validated.rejections,
      });
    }

    // `handoff_discards_testimony` fails the whole run (retryable
    // `validation_failed`). Continuing would freeze `awaitingHuman` and advance
    // past unread testimony. Exhausted retries land in deterministic fallback.
    if (
      validated.rejections.some(
        (rejection) => rejection.reason === "handoff_discards_testimony",
      )
    ) {
      throw new FeedbackExtractionGenerationError(
        "extraction_failed",
        true,
        "validation_failed",
      );
    }

    return {
      generated,
      attention,
      validated,
      runUsages: [generated.usage, attention.usage],
    };
  }

  private async proposeExtraction(
    snapshot: ExtractRunSnapshot,
    prepared: PreparedModelContext,
    questionKeys: FeedbackAnswerQuestionKey[],
  ): Promise<FeedbackExtractionGenerationResult> {
    const child = new FeedbackOperationLog(this.logger, {
      operation: "extract_propose",
      ...extractionTurnLogContext(snapshot),
    });
    child.stage("propose");
    try {
      const generated = prepared.beforeProviderCall
        ? await this.generation.propose(
            prepared.prompt,
            questionKeys,
            prepared.beforeProviderCall,
          )
        : await this.generation.propose(prepared.prompt, questionKeys);
      child.complete("generated");
      return generated;
    } catch (error) {
      child.failed(error);
      throw error;
    }
  }

  private async classifyAttention(
    snapshot: ExtractRunSnapshot,
    prepared: PreparedModelContext,
  ): Promise<FeedbackAttentionClassificationGenerationResult> {
    const child = new FeedbackOperationLog(this.logger, {
      operation: "extract_classify",
      ...extractionTurnLogContext(snapshot),
    });
    child.stage("classify");
    try {
      const attention = prepared.beforeProviderCall
        ? await this.generation.classifyAttention(
            prepared.context.messages,
            prepared.context.newParticipantMessageIds,
            prepared.beforeProviderCall,
          )
        : await this.generation.classifyAttention(
            prepared.context.messages,
            prepared.context.newParticipantMessageIds,
          );
      child.complete("classified");
      return attention;
    } catch (error) {
      child.failed(error);
      throw error;
    }
  }
}
