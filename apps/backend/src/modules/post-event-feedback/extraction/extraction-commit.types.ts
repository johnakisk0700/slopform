import type { FeedbackCampaignRow } from "@slopform/database";
import type { FeedbackConversationDocument } from "../post-event-feedback-conversation.document.js";
import type {
  ExtractPersistWritten,
  ExtractPlannedTurn,
} from "./extract.types.js";
import type { FeedbackConversationExecutionClaim } from "./execution-fence.repository.js";
import type { GoalStatusUpdate } from "./goal-progress.js";
import type { FeedbackExtractionUsage } from "../../../integrations/llm/feedback-extraction-model.service.js";
import type { FeedbackHostilityRaise } from "./operator-attention.js";
import type { OutboundReply } from "./outbound-reply.js";
import type { FeedbackExtractionContext } from "./extraction.schemas.js";
import type { FeedbackExtractionValidationResult } from "./validate-proposal.js";

export interface FeedbackExtractionPersistInput {
  readonly conversation: FeedbackConversationDocument;
  readonly campaign: FeedbackCampaignRow;
  readonly context: FeedbackExtractionContext;
  readonly validated: FeedbackExtractionValidationResult;
  readonly outbound: OutboundReply | undefined;
  readonly ordinaryReply: boolean;
  readonly model: string;
  readonly correlationId: string;
  readonly closingReason: "completed" | "declined" | null;
  readonly goalStatuses: readonly GoalStatusUpdate[];
  readonly executionClaim?: FeedbackConversationExecutionClaim;
}

export interface FeedbackExtractionTranscriptCommitInput {
  readonly planned: ExtractPlannedTurn;
  readonly written: ExtractPersistWritten;
  readonly closingReason: "completed" | "declined" | null;
  readonly goalStatuses: readonly GoalStatusUpdate[];
  readonly withdrew: boolean;
  readonly hostility: FeedbackHostilityRaise;
}

export interface FeedbackExtractionResultsWriteInput {
  readonly conversation: FeedbackConversationDocument;
  readonly campaign: FeedbackCampaignRow;
  readonly context: FeedbackExtractionContext;
  readonly validated: FeedbackExtractionValidationResult;
  readonly model: string;
  readonly correlationId: string;
}

export interface FeedbackExtractionResultsWriteCounts {
  readonly answersWritten: number;
  readonly notesWritten: number;
}

/**
 * Named flags stay independent: close, withdrawal, hostility
 * and work-supersession are not collapsed into one lifecycle enum.
 */
export interface FeedbackExtractionStateApplyInput {
  readonly conversation: FeedbackConversationDocument;
  readonly validated: FeedbackExtractionValidationResult;
  readonly goalStatuses: readonly GoalStatusUpdate[];
  readonly closingReason: "completed" | "declined" | null;
  readonly terminalOutboxId: string | null;
  readonly withdrew: boolean;
  readonly hostility: FeedbackHostilityRaise;
  readonly awaitingHuman: boolean;
  readonly handoffOutboxId: string | null;
  readonly hostileTurn: boolean;
  readonly priorHostileTurns: number;
  readonly newestParticipantMessageId: string | null;
  readonly stalledOnMessageId: string | null;
  readonly unansweredDataQuestionMessageIds: readonly string[];
  readonly cursorSeq: number;
  readonly model: string;
  readonly usage: FeedbackExtractionUsage;
  readonly serviceTier: string | null;
  readonly workSuperseded: boolean;
  readonly executionClaim?: FeedbackConversationExecutionClaim;
}
