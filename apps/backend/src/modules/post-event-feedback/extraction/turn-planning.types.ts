import type { PostEventFeedbackQuestionSetCopy } from "../question-set.js";
import type { ExtractRunSnapshot } from "./extract.types.js";
import type { FeedbackExtractionContext } from "./extraction.schemas.js";
import type {
  FeedbackAttentionClassificationGenerationResult,
  FeedbackExtractionGenerationResult,
  FeedbackExtractionUsage,
  FeedbackProviderCallGuard,
} from "./model.service.js";
import type { FeedbackExtractionPrompt } from "./prompt.js";
import type { FeedbackExtractionValidationResult } from "./validate-proposal.js";

/** Live prompt inputs and the optional provider-entry guard for one turn. */
export interface PreparedModelContext {
  readonly context: FeedbackExtractionContext;
  readonly copy: PostEventFeedbackQuestionSetCopy;
  readonly prompt: FeedbackExtractionPrompt;
  readonly estimatedPromptTokens: number;
  readonly beforeProviderCall: FeedbackProviderCallGuard | undefined;
}

/**
 * Paid propose+classify output after domain validation of claims.
 * Not a decision that current conversation state may be committed.
 */
export interface AnalyzedModelTurn {
  readonly generated: FeedbackExtractionGenerationResult;
  readonly attention: FeedbackAttentionClassificationGenerationResult;
  readonly validated: FeedbackExtractionValidationResult;
  readonly runUsages: readonly FeedbackExtractionUsage[];
}

/** Safe identifiers shared by extract_plan / propose / classify / rewrite. */
export function extractionTurnLogContext(snapshot: ExtractRunSnapshot) {
  return {
    correlationId: snapshot.correlationId,
    conversationId: snapshot.conversation._id,
    campaignId: snapshot.campaign.id,
    ...(snapshot.executionClaim
      ? {
          workRevision: snapshot.executionClaim.workRevision,
          executionEpoch: snapshot.executionClaim.epoch,
        }
      : {}),
  };
}
