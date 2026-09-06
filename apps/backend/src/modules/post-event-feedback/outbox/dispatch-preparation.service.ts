import { Injectable } from "@nestjs/common";

import type { AppTransaction, FeedbackCampaignRow } from "@slopform/database";

import { DatabaseService } from "../../../infrastructure/database/database.service.js";
import { ParticipantsRepository } from "../../participants/participants.repository.js";
import { FeedbackCampaignRepository } from "../campaign/campaign.repository.js";
import { FeedbackIngressRepository } from "../ingress/ingress.repository.js";
import {
  resolveFeedbackConversationWork,
  type FeedbackConversationDocument,
} from "../post-event-feedback-conversation.document.js";
import { FeedbackConversationRepository } from "../post-event-feedback-conversation.repository.js";
import { isCurrentAwaitingHumanCommitment } from "./current-commitment.js";
import {
  evaluateConversationDispatch,
  type DispatchSettlementAction,
} from "./dispatch-eligibility.js";
import {
  DISPATCH_CONTEXT_CLOSING_REASON_MISMATCH,
  evaluateDispatchContext,
  type OrdinaryDispatchEvidence,
} from "./dispatch-context.js";
import {
  FEEDBACK_OUTBOX_DISPATCH_LEASE_MS,
  FeedbackOutboxRepository,
} from "./outbox.repository.js";
import type { FeedbackOutboxClaimedRow } from "./outbox.types.js";
import type { FeedbackOutboxDispatchOutcome } from "./dispatcher.types.js";
import type {
  FeedbackDispatchPrepareResult,
  FeedbackOutboxGuardResult,
} from "./dispatch-preparation.types.js";

/**
 * Last-look kill switches and the token-fenced `attempting` marker.
 *
 * The first look may settle without a transaction. The final look shares the
 * short pre-send transaction so inbound acknowledgement, campaign pause and
 * consent have one total order with the marker. Ordinary reply currency is
 * checked only inside that transaction.
 *
 * Caller: FeedbackDispatchAttemptService.
 */
@Injectable()
export class FeedbackDispatchPreparationService {
  constructor(
    private readonly database: DatabaseService,
    private readonly campaigns: FeedbackCampaignRepository,
    private readonly outbox: FeedbackOutboxRepository,
    private readonly ingress: FeedbackIngressRepository,
    private readonly conversations: FeedbackConversationRepository,
    private readonly participants: ParticipantsRepository,
  ) {}

  async prepare(
    claim: FeedbackOutboxClaimedRow,
    phoneAtLaunch: string,
  ): Promise<FeedbackDispatchPrepareResult> {
    return this.database.transaction(async (transaction) => {
      // Webhook acknowledgement takes this lock before committing a durable
      // ingress row. Taking it first here makes "inbound accepted" and provider
      // entry one total order without holding either lock over the network call.
      await this.ingress.lockInboundPhone(transaction, phoneAtLaunch);
      // This mutex is shared with STOP/takeover/provider observations. Their
      // conversation transition and our final reload+marker therefore have one order:
      // a control change either cancels the claim first, or observes an already
      // committed provider-entry marker that is intentionally no longer safe
      // to cancel.
      await this.outbox.lockConversation(transaction, claim.conversationId);
      // A shared campaign row lock gives pause/close the same total-order fence
      // without serializing messages from the campaign with each other. Its
      // status UPDATE either commits before this read, or waits until our send
      // marker commits; there is no final-read -> marker gap for the kill
      // switch.
      const campaign = await this.campaigns.findCampaignByIdForShare(
        transaction,
        claim.campaignId,
      );
      const finalGuard = await this.guardCurrentState(
        claim,
        transaction,
        campaign ?? null,
        phoneAtLaunch,
      );
      if (finalGuard.state === "settled") return finalGuard;

      const attempting = await this.outbox.markDispatchAttemptStarted(
        claim.id,
        claim.claimToken,
        new Date(),
        FEEDBACK_OUTBOX_DISPATCH_LEASE_MS,
        finalGuard.authorizedStopOutboxId,
        transaction,
      );
      if (!attempting) {
        return settled(claim.id, "claim_lost");
      }
      return {
        state: "prepared" as const,
        attempting,
        phoneAtLaunch: finalGuard.phoneAtLaunch,
      };
    });
  }

  /**
   * Re-checks every mutable kill switch. Bot rows are cancelled after takeover;
   * `staff` rows are the human's own message and remain valid under that same
   * control state. Only completion/decline copy and STOP acknowledgement are
   * allowed through after their corresponding terminal transition.
   */
  async guardCurrentState(
    claim: FeedbackOutboxClaimedRow,
    transaction?: AppTransaction,
    lockedCampaign?: FeedbackCampaignRow | null,
    lockedPhoneAtLaunch?: string,
  ): Promise<FeedbackOutboxGuardResult> {
    const campaign =
      lockedCampaign === undefined
        ? await this.campaigns.findCampaignById(claim.campaignId, transaction)
        : (lockedCampaign ?? undefined);
    if (!campaign) {
      return this.settleClaim(
        claim,
        { action: "finish_failed", reason: "campaign_missing" },
        transaction,
      );
    }

    const conversation = await this.conversations.findById(
      claim.conversationId,
      transaction,
    );
    if (!conversation) {
      return this.settleClaim(
        claim,
        { action: "finish_failed", reason: "conversation_missing" },
        transaction,
      );
    }

    const decision = evaluateConversationDispatch({
      claim,
      campaign,
      conversation,
      ...(lockedPhoneAtLaunch === undefined ? {} : { lockedPhoneAtLaunch }),
    });
    if (decision.state === "settle") {
      return this.settleClaim(claim, decision, transaction);
    }
    const { permittedStopAcknowledgement, permittedTerminalMessage } = decision;

    const authority = evaluateDispatchContext({
      context: claim.dispatchContext,
      kind: claim.kind,
      dedupeKey: claim.dedupeKey,
      conversationId: claim.conversationId,
    });
    if (authority.state === "reject") {
      return this.settleClaim(
        claim,
        { action: "finish_cancelled", reason: authority.reason },
        transaction,
      );
    }
    if (
      authority.context.purpose === "extraction_closing" &&
      conversation.lifecycle.state === "closed" &&
      conversation.lifecycle.reason !== authority.context.closingReason
    ) {
      return this.settleClaim(
        claim,
        {
          action: "finish_cancelled",
          reason: DISPATCH_CONTEXT_CLOSING_REASON_MISMATCH,
        },
        transaction,
      );
    }

    // STOP atomically withdraws opt-in before its acknowledgement is dispatched.
    // That exact acknowledgement is the sole consent exception; every other
    // outbound reloads the participant row at both guard points.
    if (!permittedStopAcknowledgement) {
      const participant = transaction
        ? await this.participants.findByIdForUpdate(
            transaction,
            conversation.respondentParticipantId,
          )
        : await this.participants.findById(
            conversation.respondentParticipantId,
          );
      if (!participant) {
        return this.settleClaim(
          claim,
          { action: "finish_failed", reason: "participant_missing" },
          transaction,
        );
      }
      if (!participant.postEventFeedbackWhatsappOptIn) {
        return this.settleClaim(
          claim,
          { action: "finish_cancelled", reason: "consent_withdrawn" },
          transaction,
        );
      }
    }

    if (
      conversation.awaitingHuman &&
      claim.kind !== "staff" &&
      !permittedTerminalMessage &&
      !isCurrentAwaitingHumanCommitment(claim.id, conversation)
    ) {
      return this.settleClaim(
        claim,
        { action: "finish_cancelled", reason: "awaiting_human" },
        transaction,
      );
    }

    if (
      transaction &&
      authority.context.purpose === "extraction_reply" &&
      !permittedTerminalMessage &&
      !isCurrentAwaitingHumanCommitment(claim.id, conversation)
    ) {
      const staleReason = await this.ordinaryExtractionReplyStaleReason(
        authority.context.evidence,
        conversation,
        transaction,
      );
      if (staleReason) {
        return this.settleClaim(
          claim,
          { action: "finish_cancelled", reason: staleReason },
          transaction,
        );
      }
    }

    return {
      state: "ready",
      phoneAtLaunch: conversation.phoneAtLaunch,
      authorizedStopOutboxId: permittedStopAcknowledgement ? claim.id : null,
    };
  }

  private async settleClaim(
    claim: FeedbackOutboxClaimedRow,
    settlement: {
      readonly action: DispatchSettlementAction;
      readonly reason: string;
    },
    transaction?: AppTransaction,
  ): Promise<
    Extract<FeedbackOutboxGuardResult, { readonly state: "settled" }>
  > {
    const executor = transaction ? ([transaction] as const) : [];
    if (settlement.action === "release") {
      const released = await this.outbox.releaseDispatchClaim(
        claim.id,
        claim.claimToken,
        new Date(),
        settlement.reason,
        ...executor,
      );
      return settled(claim.id, released ? "held" : "claim_lost");
    }

    const status =
      settlement.action === "finish_failed" ? "failed" : "cancelled";
    const finished = await this.outbox.finishDispatchClaimBeforeAttempt(
      claim.id,
      claim.claimToken,
      status,
      new Date(),
      settlement.reason,
      ...executor,
    );
    return settled(claim.id, finished ? status : "claim_lost");
  }

  /**
   * Final ordinary-reply fence. Evidence is the original model snapshot
   * stored on the row; the phone lock makes the ingress comparison include
   * every webhook acknowledgement that won before provider entry.
   */
  private async ordinaryExtractionReplyStaleReason(
    evidence: OrdinaryDispatchEvidence,
    conversation: FeedbackConversationDocument,
    transaction: AppTransaction,
  ): Promise<string | undefined> {
    const snapshotSeq = evidence.latestMessageSeq ?? 0;
    const newerTestimony = conversation.messages.some(
      (message) => message.actor === "participant" && message.seq > snapshotSeq,
    );
    if (newerTestimony) return "superseded_by_newer_testimony";

    const currentWork = resolveFeedbackConversationWork(conversation.work);
    const controlGenerationChanged =
      conversation.control.mode !== evidence.control.mode ||
      conversation.control.source !== evidence.control.source ||
      conversation.control.changedAt.toISOString() !==
        evidence.control.changedAt;
    const executionGenerationChanged =
      currentWork.executionEpoch !== evidence.work.executionEpoch;
    const campaignResumeGenerationChanged =
      (currentWork.campaignResumeGeneration ?? null) !==
      evidence.work.campaignResumeGeneration;
    // A healthy execution may persist its row at revision N and then settle a
    // future reminder as N+1. Anything outside that narrow diagnostic range is
    // definitely not the work generation which produced this decision; exact
    // ABA authorization comes from control/resume/epoch above, not this range.
    const impossibleWorkRevision =
      currentWork.revision < evidence.work.revision ||
      currentWork.revision > evidence.work.revision + 1;
    if (
      controlGenerationChanged ||
      executionGenerationChanged ||
      campaignResumeGenerationChanged ||
      impossibleWorkRevision
    ) {
      return "superseded_by_newer_work";
    }

    const newerDurableIngress = await this.ingress.hasInboundBeyondSnapshot(
      transaction,
      {
        phoneE164: conversation.phoneAtLaunch,
        conversationId: conversation._id,
        snapshotIngressIds: evidence.participantIngressIds,
      },
    );
    return newerDurableIngress ? "superseded_by_newer_testimony" : undefined;
  }
}

function settled(
  outboxId: string,
  outcome: FeedbackOutboxDispatchOutcome,
): Extract<FeedbackOutboxGuardResult, { readonly state: "settled" }> {
  return { state: "settled", result: { outboxId, outcome } };
}
