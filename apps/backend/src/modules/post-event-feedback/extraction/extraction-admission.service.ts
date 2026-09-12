import { Injectable } from "@nestjs/common";

import { DatabaseService } from "../../../infrastructure/database/database.service.js";
import { ParticipantsRepository } from "../../participants/participants.repository.js";
import { FeedbackCampaignRepository } from "../campaign/campaign.repository.js";
import { FeedbackConversationRepository } from "../post-event-feedback-conversation.repository.js";
import { FeedbackConversationExecutionFence } from "./execution-fence.service.js";
import { FeedbackConversationExecutionGuardError } from "./execution-guard.js";
import { skipExtractOutcome } from "./extract-admission.js";
import {
  PostEventFeedbackCampaignNotFoundError,
  PostEventFeedbackConversationNotFoundError,
  type ExtractAdmission,
  type ExtractFeedbackInput,
  type ExtractFeedbackResult,
  type ExtractRunSnapshot,
} from "./extract.types.js";
import { FeedbackResultsRepository } from "./results.repository.js";

/** Decide whether a model call is needed; settle cursor-only work here. */
@Injectable()
export class FeedbackExtractionAdmissionService {
  constructor(
    private readonly database: DatabaseService,
    private readonly campaigns: FeedbackCampaignRepository,
    private readonly results: FeedbackResultsRepository,
    private readonly conversations: FeedbackConversationRepository,
    private readonly participants: ParticipantsRepository,
    private readonly executionFence: FeedbackConversationExecutionFence,
  ) {}

  async admit(input: ExtractFeedbackInput): Promise<ExtractAdmission> {
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
    if (skipped) return skippedAdmission(conversation, skipped);

    const pending = conversation.messages.filter(
      (message) => message.seq > conversation.extraction.cursorSeq,
    );
    if (!pending.some((message) => message.actor === "participant")) {
      await this.advanceCursorWithoutTestimony(conversation, cursorSeq, input);
      return skippedAdmission(
        conversation,
        "skipped_no_new_testimony",
        cursorSeq,
      );
    }

    const campaign = await this.campaigns.findCampaignById(
      conversation.campaignId,
    );
    if (!campaign) {
      throw new PostEventFeedbackCampaignNotFoundError(conversation.campaignId);
    }
    if (campaign.status !== "launched") {
      return skippedAdmission(conversation, "skipped_campaign_inactive");
    }
    const participant = await this.participants.findById(
      conversation.respondentParticipantId,
    );
    if (!participant?.postEventFeedbackWhatsappOptIn) {
      return skippedAdmission(conversation, "skipped_consent_withdrawn");
    }

    return {
      kind: "run",
      snapshot: {
        conversation,
        campaign,
        cursorSeq,
        correlationId: input.correlationId,
        executionClaim: input.executionClaim,
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
        workRevision: input.executionClaim.workRevision,
        executionEpoch: input.executionClaim.epoch,
      });
    });
  }
}

function skippedAdmission(
  conversation: ExtractRunSnapshot["conversation"],
  outcome: ExtractFeedbackResult["outcome"],
  cursorSeq = conversation.extraction.cursorSeq,
): ExtractAdmission {
  return {
    kind: "complete",
    result: {
      outcome,
      conversationId: conversation._id,
      cursorSeq,
      answersWritten: 0,
      notesWritten: 0,
    },
  };
}
