import { Injectable } from "@nestjs/common";

import { DatabaseService } from "../../../infrastructure/database/database.service.js";
import { FeedbackCampaignRepository } from "../campaign/campaign.repository.js";
import { FeedbackIngressRepository } from "../ingress/ingress.repository.js";
import { FeedbackResultsRepository } from "./results.repository.js";
import { FeedbackConversationRepository } from "../post-event-feedback-conversation.repository.js";
import type { FeedbackConversationDocument } from "../post-event-feedback-conversation.document.js";
import { ParticipantsRepository } from "../../participants/participants.repository.js";
import type { FeedbackConversationExecutionClaim } from "./execution-fence.repository.js";
import { FeedbackConversationExecutionFence } from "./execution-fence.service.js";
import {
  FeedbackConversationExecutionGuardError,
  executionSnapshotGuardReason,
} from "./execution-guard.js";

/**
 * Live-state checks immediately before a paid provider call and immediately
 * before an outbound row is admitted. Each method keeps its own lock order.
 */
@Injectable()
export class FeedbackExtractionGuards {
  constructor(
    private readonly database: DatabaseService,
    private readonly ingress: FeedbackIngressRepository,
    private readonly results: FeedbackResultsRepository,
    private readonly executionFence: FeedbackConversationExecutionFence,
    private readonly campaigns: FeedbackCampaignRepository,
    private readonly participants: ParticipantsRepository,
    private readonly conversations: FeedbackConversationRepository,
  ) {}

  /**
   * Provider-entry boundary, inside the limiter slot, before billing. Lock
   * order: ingress, conversation mutex, execution token, campaign, consent;
   * conversation read last. Commits before the network call.
   */
  async assertProviderEntry(
    claim: FeedbackConversationExecutionClaim,
    snapshot: FeedbackConversationDocument,
  ): Promise<void> {
    if (claim.conversationId !== snapshot._id) {
      throw new FeedbackConversationExecutionGuardError(
        snapshot._id,
        "execution_invariant_broken",
      );
    }
    await this.database.transaction(async (transaction) => {
      // Ingress first: in-flight ACK commits before we inspect; later waits.
      await this.ingress.lockInboundPhone(transaction, snapshot.phoneAtLaunch);
      // Conversation mutex second (STOP / takeover / close / awaiting-human).
      await this.results.lockConversation(transaction, snapshot._id);

      const executionCurrent = await this.executionFence.isCurrent(
        transaction,
        claim,
      );
      const campaign = await this.campaigns.findCampaignByIdForShare(
        transaction,
        snapshot.campaignId,
      );
      const participant = await this.participants.findByIdForUpdate(
        transaction,
        snapshot.respondentParticipantId,
      );
      const newerInbound = await this.ingress.hasInboundBeyondSnapshot(
        transaction,
        {
          phoneE164: snapshot.phoneAtLaunch,
          conversationId: snapshot._id,
          snapshotIngressIds: snapshot.messages.flatMap((message) =>
            message.actor === "participant" && message.ingressId
              ? [message.ingressId]
              : [],
          ),
        },
      );
      if (!executionCurrent) {
        throw new FeedbackConversationExecutionGuardError(
          snapshot._id,
          "execution_claim_lost",
        );
      }
      if (!campaign || !participant) {
        throw new FeedbackConversationExecutionGuardError(
          snapshot._id,
          "execution_invariant_broken",
        );
      }
      if (
        campaign.status !== "launched" ||
        !participant.postEventFeedbackWhatsappOptIn ||
        newerInbound
      ) {
        throw new FeedbackConversationExecutionGuardError(
          snapshot._id,
          "authoritative_state_changed",
        );
      }

      // Conversation row last while the other fences are held. Passing this
      // read is provider entry.
      const conversation = await this.conversations.findById(
        snapshot._id,
        transaction,
      );
      const guardReason = executionSnapshotGuardReason(
        conversation,
        snapshot,
        claim,
      );
      if (guardReason) {
        throw new FeedbackConversationExecutionGuardError(
          snapshot._id,
          guardReason,
        );
      }
    });
  }

  /**
   * Last look before a phone send. Snapshot is pre-provider; takeover, close
   * or consent withdraw can land during the call. Every reason but newer
   * testimony silences all outbound including close/handoff. Newer testimony
   * drops only an ordinary reply. Answers/notes/cursor still write. Reasons
   * are DB reads so replay agrees.
   */
  async reviewBeforeSending(input: {
    readonly conversation: FeedbackConversationDocument;
    readonly cursorSeq: number;
    readonly staleOnNewerTestimony: boolean;
    readonly executionClaim?: FeedbackConversationExecutionClaim;
  }): Promise<string | undefined> {
    const current = await this.conversations.findById(input.conversation._id);
    if (!current) {
      if (input.executionClaim) {
        throw new FeedbackConversationExecutionGuardError(
          input.conversation._id,
          "execution_invariant_broken",
        );
      }
      return "conversation_missing";
    }
    if (input.executionClaim) {
      const guardReason = executionSnapshotGuardReason(
        current,
        input.conversation,
        input.executionClaim,
      );
      if (
        guardReason === "execution_claim_lost" ||
        guardReason === "execution_invariant_broken"
      ) {
        throw new FeedbackConversationExecutionGuardError(
          input.conversation._id,
          guardReason,
        );
      }
      if (guardReason === "authoritative_state_changed") {
        if (current.lifecycle.state !== "open") {
          return "conversation_closed";
        }
        if (current.control.mode !== "bot") {
          return "human_control";
        }
        return "superseded_by_newer_work";
      }
    }
    if (current.lifecycle.state !== "open") {
      return "conversation_closed";
    }
    if (current.control.mode !== "bot") {
      return "human_control";
    }

    const participant = await this.participants.findById(
      input.conversation.respondentParticipantId,
    );
    if (!participant?.postEventFeedbackWhatsappOptIn) {
      return "consent_withdrawn";
    }

    if (
      input.staleOnNewerTestimony &&
      current.messages.some(
        (message) =>
          message.actor === "participant" && message.seq > input.cursorSeq,
      )
    ) {
      return "superseded_by_newer_testimony";
    }
    return undefined;
  }
}
