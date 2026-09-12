import type { FeedbackCampaignRow, MessageOutboxRow } from "@slopform/database";

import type { FeedbackConversationDocument } from "../post-event-feedback-conversation.document.js";
import type { FeedbackExtractOutcome } from "../metrics.service.js";
import type { FeedbackHostilityRaise } from "./operator-attention.js";
import type { GoalStatusUpdate } from "./goal-progress.js";
import type { OutboundReply } from "./outbound-reply.js";
import type { FeedbackExtractionContext } from "./extraction.schemas.js";
import type { FeedbackExtractionValidationResult } from "./validate-proposal.js";
import type { FeedbackExtractionUsage } from "../../../integrations/llm/feedback-extraction-model.service.js";
import type { FeedbackConversationExecutionClaim } from "./execution-fence.repository.js";

export class PostEventFeedbackConversationNotFoundError extends Error {
  constructor(conversationId: string) {
    super(`Feedback conversation ${conversationId} was not found`);
    this.name = PostEventFeedbackConversationNotFoundError.name;
  }
}

export class PostEventFeedbackCampaignNotFoundError extends Error {
  constructor(campaignId: string) {
    super(`Feedback campaign ${campaignId} was not found`);
    this.name = PostEventFeedbackCampaignNotFoundError.name;
  }
}

export interface ExtractFeedbackInput {
  readonly conversationId: string;
  readonly correlationId: string;
  readonly executionClaim: FeedbackConversationExecutionClaim;
}

export interface ExtractFeedbackResult {
  readonly outcome: FeedbackExtractOutcome;
  readonly conversationId: string;
  readonly cursorSeq: number;
  readonly answersWritten: number;
  readonly notesWritten: number;
  readonly outboxId?: string;
  readonly model?: string;
}

export type ExtractAdmission =
  | { readonly kind: "complete"; readonly result: ExtractFeedbackResult }
  | { readonly kind: "run"; readonly snapshot: ExtractRunSnapshot };

/** Conversation and campaign loaded for one extraction run. */
export interface ExtractRunSnapshot {
  readonly conversation: FeedbackConversationDocument;
  readonly campaign: FeedbackCampaignRow;
  readonly cursorSeq: number;
  readonly correlationId: string;
  readonly executionClaim: FeedbackConversationExecutionClaim;
}

/**
 * Immutable facts from the paid snapshot. Policy flags such as duty-of-care
 * and ordinaryReply are derived; they are not stored here.
 */
export interface TurnEvidence {
  readonly context: FeedbackExtractionContext;
  readonly validated: FeedbackExtractionValidationResult;
  readonly recordedStatuses: readonly GoalStatusUpdate[];
  readonly hostileTurn: boolean;
  readonly stoppingForHostility: boolean;
  readonly rewriteSuperseded: boolean;
  readonly stalledOnMessageId: string | null;
  readonly unansweredDataQuestionMessageIds: readonly string[];
  readonly newestParticipantMessageId: string | null;
  readonly runUsage: FeedbackExtractionUsage;
  readonly model: string;
  readonly serviceTier: string | null;
}

/**
 * Orthogonal proposed outcomes. Goals, withdrawal, hostility, close and
 * outbound stay independent — not a lifecycle enum.
 */
export interface ProposedDisposition {
  readonly goalStatuses: readonly GoalStatusUpdate[];
  readonly withdrew: boolean;
  readonly hostility: FeedbackHostilityRaise;
  readonly closingReason: "completed" | "declined" | null;
  readonly outboundIntent: OutboundReply | undefined;
}

/** Validated snapshot facts plus the proposed outbound and lifecycle decision. */
export interface ExtractPlannedTurn {
  readonly evidence: TurnEvidence;
  readonly proposed: ProposedDisposition;
}

/**
 * Persist-time outbound losses. Ingress and newer work may both be true;
 * legacy close-crossing is a separate flag. Does not replace written results.
 */
export interface CommitSuppression {
  readonly newerIngress: boolean;
  readonly newerWork: boolean;
  readonly legacyClosingProviderCrossed: boolean;
}

export interface ExtractPersistWritten {
  readonly answersWritten: number;
  readonly notesWritten: number;
  readonly outboundSuppressedByNewerIngress: boolean;
  readonly outboundSuppressedByLegacyClosing: boolean;
  readonly executionSuperseded: boolean;
  readonly outbox?: MessageOutboxRow;
}

export interface ExtractConversationState {
  readonly closedNow: boolean;
  readonly terminalCommitted: boolean;
  readonly raisedIncident: boolean;
}

export interface ExtractCommitResult {
  readonly written: ExtractPersistWritten;
  readonly state: ExtractConversationState;
  readonly closingReason: "completed" | "declined" | null;
  readonly raisedIncident: boolean;
  readonly effectiveOutbox?: MessageOutboxRow;
}
