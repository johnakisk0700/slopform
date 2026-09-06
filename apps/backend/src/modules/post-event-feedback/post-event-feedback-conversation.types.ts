import type { PostEventFeedbackAttentionReason } from "./attention.js";
import type {
  FeedbackConversationDocument,
  FeedbackConversationExtractionUsage,
  FeedbackConversationGoal,
  FeedbackConversationLifecycleReason,
  FeedbackConversationMessage,
  FeedbackConversationWork,
} from "./post-event-feedback-conversation.document.js";
import type { FeedbackConversationTransitionResult } from "./post-event-feedback-conversation.state.js";

/** Narrow evidence the campaign summary feeds into `wentWrong` / `wentWell`. */
export type FeedbackCampaignAttentionEvidence = {
  readonly conversationId: string;
  readonly respondentParticipantId: string;
  readonly kind: PostEventFeedbackAttentionReason;
  readonly messageExcerpt: string | null;
};

export interface FeedbackConversationLaunchInput {
  readonly campaignId: string;
  readonly respondentParticipantId: string;
  readonly phoneAtLaunch: string;
  readonly launchedAt: Date;
  readonly goals?: readonly FeedbackConversationGoal[];
}

export interface FeedbackConversationCreationResult {
  readonly created: boolean;
  readonly conversation: FeedbackConversationDocument;
}

export interface FeedbackConversationWorkTransitionResult extends FeedbackConversationTransitionResult {
  readonly work: FeedbackConversationWork;
}

export interface FeedbackConversationAppendResult {
  readonly appended: boolean;
  readonly message: FeedbackConversationMessage;
  readonly conversation: FeedbackConversationDocument;
}

export interface FeedbackConversationExtractionAccounting {
  readonly conversationId: string;
  readonly extraction: {
    readonly model: string | null;
    readonly usage: FeedbackConversationExtractionUsage | null;
    readonly serviceTier: string | null;
  };
}

export interface FeedbackConversationWorkCursor {
  readonly nextActionAt: Date;
  readonly conversationId: string;
}

export interface FeedbackCampaignLifecycleStats {
  readonly campaignId: string;
  readonly totalCount: number;
  readonly openCount: number;
  readonly latestClosedAt: Date | null;
}

export interface FeedbackTerminalOutboxCandidate {
  readonly conversationId: string;
  readonly outboxId: string;
}

export type FeedbackConversationOverviewStats = {
  total: number;
  open: number;
  closed: number;
  byClosedReason: Record<FeedbackConversationLifecycleReason, number>;
  needsAttention: number;
  extractionParked: number;
  attentionByReason: Array<{
    reason: PostEventFeedbackAttentionReason;
    count: number;
  }>;
};

export interface FeedbackConversationAdvanceCursorInput {
  readonly conversationId: string;
  readonly toSeq: number;
  readonly at: Date;
  readonly model?: string | null;
  readonly serviceTier?: string | null;
  readonly usage?: FeedbackConversationExtractionUsage;
  readonly workRevision?: number;
  readonly executionEpoch?: number;
}

export interface FeedbackConversationAwaitHumanCursorInput {
  readonly conversationId: string;
  readonly toSeq: number;
  readonly at: Date;
  readonly model: string;
  readonly serviceTier: string | null;
  readonly usage: FeedbackConversationExtractionUsage;
  readonly workRevision?: number;
  readonly executionEpoch?: number;
}

export interface FeedbackConversationCloseCursorInput {
  readonly conversationId: string;
  readonly toSeq: number;
  readonly reason: "completed" | "declined";
  readonly terminalOutboxId: string | null;
  readonly at: Date;
  readonly model: string;
  readonly serviceTier: string | null;
  readonly usage: FeedbackConversationExtractionUsage;
  readonly workRevision?: number;
  readonly executionEpoch?: number;
}
