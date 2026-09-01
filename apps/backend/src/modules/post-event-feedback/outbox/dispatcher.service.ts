import { Inject, Injectable, Logger } from "@nestjs/common";

import type {
  AppTransaction,
  FeedbackCampaignRow,
  MessageOutboxRow,
} from "@slopform/database";

import { DatabaseService } from "../../../infrastructure/database/database.service.js";
import { ParticipantsRepository } from "../../participants/participants.repository.js";
import { FeedbackCampaignRepository } from "../campaign/campaign.repository.js";
import { isFeedbackClosingDedupeKey } from "../extraction/extraction.schemas.js";
import { FeedbackIngressRepository } from "../ingress/ingress.repository.js";
import {
  resolveFeedbackConversationWork,
  type FeedbackConversationDocument,
} from "../post-event-feedback-conversation.document.js";
import { FeedbackConversationRepository } from "../post-event-feedback-conversation.repository.js";
import { createFeedbackStopAckDedupeKey } from "../question-set.js";
import { isCurrentAwaitingHumanCommitment } from "./current-commitment.js";
import { FeedbackOutboundLogRepository } from "./outbound-log.repository.js";
import { feedbackOutboundDecisionSchema } from "./outbound-log.schemas.js";
import {
  outboundConversationSnapshotSchema,
  type OutboundConversationSnapshot,
} from "./outbound-log.snapshot.js";
import {
  FEEDBACK_OUTBOX_DISPATCH_HEARTBEAT_MS,
  FEEDBACK_OUTBOX_DISPATCH_LEASE_MS,
  FEEDBACK_OUTBOX_RECOVERY_MS,
  FeedbackOutboxRepository,
  type FeedbackOutboxClaimedRow,
} from "./outbox.repository.js";
import { FeedbackOutboundTranscriptService } from "./outbound-transcript.service.js";
import {
  FEEDBACK_SEND_LIMITER,
  type FeedbackSendLimiter,
} from "./session-pacer.js";
import { FEEDBACK_TRANSPORT, type FeedbackTransport } from "./transport.js";

export type FeedbackOutboxDispatchOutcome =
  | "sent"
  | "failed"
  | "cancelled"
  | "held"
  | "ambiguous"
  | "claim_lost"
  | "deferred";

export type FeedbackOutboxDispatchItemResult = {
  readonly outboxId: string;
  readonly outcome: FeedbackOutboxDispatchOutcome;
};

export type FeedbackOutboxDispatchBatchResult = {
  readonly claimedCount: number;
  readonly quarantinedCount: number;
  readonly items: readonly FeedbackOutboxDispatchItemResult[];
};

type FeedbackOutboxGuardResult =
  | {
      readonly state: "ready";
      readonly phoneAtLaunch: string;
      /** Exact STOP lifecycle authority for the campaign-status marker CAS. */
      readonly authorizedStopOutboxId: string | null;
    }
  | {
      readonly state: "settled";
      readonly result: FeedbackOutboxDispatchItemResult;
    };

type FeedbackSendSlotResult =
  | { readonly state: "granted" }
  | { readonly state: "failed"; readonly error: unknown };

type OrdinaryExtractionSnapshot =
  | { readonly state: "not_ordinary" }
  | { readonly state: "invalid" }
  | {
      readonly state: "snapshot";
      readonly snapshot: OutboundConversationSnapshot;
    };

/**
 * Direct PostgreSQL outbox dispatcher.
 *
 * BullMQ is deliberately absent. PostgreSQL owns due work, claims and recovery;
 * Redis only grants deployment-wide provider start slots. A row remains safely
 * reclaimable while `claimed`. Immediately before invoking the raw transport,
 * a token-fenced CAS writes `attempting` + `send_started_at`. From that point an
 * uncertain result is quarantined as `ambiguous` and is never selected by the
 * claim query again.
 */
@Injectable()
export class MessageOutboxDispatcherService {
  private readonly logger = new Logger(MessageOutboxDispatcherService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly campaigns: FeedbackCampaignRepository,
    private readonly outbox: FeedbackOutboxRepository,
    private readonly ingress: FeedbackIngressRepository,
    private readonly outboundLogs: FeedbackOutboundLogRepository,
    private readonly conversations: FeedbackConversationRepository,
    private readonly participants: ParticipantsRepository,
    private readonly outboundTranscript: FeedbackOutboundTranscriptService,
    @Inject(FEEDBACK_TRANSPORT)
    private readonly transport: FeedbackTransport,
    @Inject(FEEDBACK_SEND_LIMITER)
    private readonly sendLimiter: FeedbackSendLimiter,
  ) {}

  /**
   * Processes one bounded claim batch. Per-row failures are isolated so one bad
   * conversation cannot strand every later row leased by this replica.
   */
  async dispatchBatch(
    now = new Date(),
  ): Promise<FeedbackOutboxDispatchBatchResult> {
    const [expiredAttempts, staleLegacySending] = await Promise.all([
      this.outbox.findExpiredDispatchAttempts(now),
      this.outbox.findStaleLegacySending(now),
    ]);
    const parkByConversation = new Map<string, Promise<void>>();
    const parkOnce = (
      row: MessageOutboxRow,
      transaction: AppTransaction,
    ): Promise<void> => {
      const existing = parkByConversation.get(row.conversationId);
      if (existing) return existing;
      const pending = this.parkUncertainDelivery(row, transaction);
      parkByConversation.set(row.conversationId, pending);
      return pending;
    };
    const quarantined = await Promise.all([
      ...expiredAttempts.map(async (row) => {
        if (!row.claimToken) return false;
        try {
          return this.database.transaction(async (transaction) => {
            await this.outbox.lockConversation(transaction, row.conversationId);
            const quarantined =
              await this.outbox.quarantineExpiredDispatchAttempt(
                row.id,
                row.claimToken!,
                transaction,
              );
            if (!quarantined) return false;
            await parkOnce(quarantined, transaction);
            return true;
          });
        } catch (error) {
          this.logQuarantineProjectionFailure(row, error);
          return false;
        }
      }),
      ...staleLegacySending.map(async (row) => {
        try {
          return this.database.transaction(async (transaction) => {
            await this.outbox.lockConversation(transaction, row.conversationId);
            const quarantined = await this.outbox.quarantineStaleLegacySending(
              row.id,
              FEEDBACK_OUTBOX_RECOVERY_MS,
              transaction,
            );
            if (!quarantined) return false;
            await parkOnce(quarantined, transaction);
            return true;
          });
        } catch (error) {
          this.logQuarantineProjectionFailure(row, error);
          return false;
        }
      }),
    ]);
    const quarantinedCount = quarantined.filter(Boolean).length;
    const terminalCandidates =
      await this.outbox.listTerminalDispatchCandidates();
    const terminalOutboxIds =
      await this.conversations.listCurrentTerminalOutboxIds(terminalCandidates);
    const claims = await this.outbox.claimDispatchBatch(
      now,
      undefined,
      undefined,
      terminalOutboxIds,
    );
    // Different conversations use bounded parallel lanes. Claims for one
    // conversation are still serialized as a second line of defence around
    // the repository's cross-replica FIFO eligibility predicate.
    const resultsById = new Map<string, FeedbackOutboxDispatchItemResult>();
    await Promise.all(
      groupClaimsByConversation(claims).map(async (conversationClaims) => {
        for (const claim of conversationClaims) {
          resultsById.set(claim.id, await this.dispatchClaimSafely(claim));
        }
      }),
    );
    const items = claims.map((claim) => {
      const result = resultsById.get(claim.id);
      if (!result) {
        throw new Error(`Feedback outbox claim ${claim.id} was not dispatched`);
      }
      return result;
    });

    return { claimedCount: claims.length, quarantinedCount, items };
  }

  private async dispatchClaimSafely(
    claim: FeedbackOutboxClaimedRow,
  ): Promise<FeedbackOutboxDispatchItemResult> {
    try {
      return await this.dispatchClaim(claim);
    } catch (error) {
      // The row stays claimed or attempting. Its durable lease, not this
      // process's stack, decides whether recovery may retry or quarantine it.
      this.logger.error({
        event: "feedback.outbox.dispatch_unhandled",
        outboxId: claim.id,
        error: { name: error instanceof Error ? error.name : "Error" },
      });
      return { outboxId: claim.id, outcome: "deferred" };
    }
  }

  private async dispatchClaim(
    claim: FeedbackOutboxClaimedRow,
  ): Promise<FeedbackOutboxDispatchItemResult> {
    const firstGuard = await this.guardCurrentState(claim);
    if (firstGuard.state === "settled") {
      return firstGuard.result;
    }

    const recorded = await this.outboundTranscript.record(
      claim,
      new Date(),
      claim.id,
      { claimToken: claim.claimToken },
    );
    if (recorded.outcome === "cancelled") {
      return { outboxId: claim.id, outcome: "cancelled" };
    }
    if (recorded.outcome === "claim_lost") {
      return { outboxId: claim.id, outcome: "claim_lost" };
    }

    // Global pacing may outlive the initial lease as replicas are added. Keep
    // this exact token alive while waiting, then renew once more after the slot
    // before reading state and crossing the no-return marker.
    const ownsClaimAfterPacing =
      await this.waitForSendSlotWithClaimHeartbeat(claim);
    if (!ownsClaimAfterPacing) {
      return { outboxId: claim.id, outcome: "claim_lost" };
    }

    const prepared = await this.database.transaction(async (transaction) => {
      // Webhook acknowledgement takes this lock before committing a durable
      // ingress row. Taking it first here makes "inbound accepted" and provider
      // entry one total order without holding either lock over the network call.
      await this.ingress.lockInboundPhone(
        transaction,
        firstGuard.phoneAtLaunch,
      );
      // This mutex is shared with STOP/takeover/provider observations. Their
      // Mongo transition and our final reload+marker therefore have one order:
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
        firstGuard.phoneAtLaunch,
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
    if (prepared.state === "settled") {
      return prepared.result;
    }
    const { attempting } = prepared;
    const sendInput = {
      to: prepared.phoneAtLaunch,
      text: claim.body,
      outboxId: claim.id,
    };
    if (!attempting) {
      return { outboxId: claim.id, outcome: "claim_lost" };
    }

    let result: Awaited<ReturnType<FeedbackTransport["sendText"]>>;
    try {
      // This is deliberately the first fallible operation after the durable
      // send marker. Every state/consent/phone lookup completed above it.
      result = await this.transport.sendText(sendInput);
    } catch (error) {
      return this.markAmbiguous(
        attempting,
        claim.claimToken,
        "unexpected_transport_error",
        error,
      );
    }

    if (result.outcome === "accepted") {
      const completedAt = new Date();
      const sent = await this.outbox.markDispatchSent(
        attempting.id,
        claim.claimToken,
        {
          completedAt,
          providerLogId: result.providerLogId,
          ...(result.providerMessageId
            ? { providerMessageId: result.providerMessageId }
            : {}),
          deliveryStatus: "sent",
          sentAt: completedAt,
        },
      );
      if (!sent) {
        this.logFenceLoss(attempting.id, "accepted");
        return { outboxId: attempting.id, outcome: "claim_lost" };
      }
      this.logger.log({
        event: "feedback.outbox.dispatched",
        outboxId: attempting.id,
      });
      return { outboxId: attempting.id, outcome: "sent" };
    }

    if (result.outcome === "not-accepted") {
      const failed = await this.outbox.markDispatchFailed(
        attempting.id,
        claim.claimToken,
        new Date(),
        boundedFailure(`transport_not_accepted:${result.reason}`),
      );
      if (!failed) {
        this.logFenceLoss(attempting.id, "not_accepted");
        return { outboxId: attempting.id, outcome: "claim_lost" };
      }
      await this.raiseUndeliveredAttention(attempting);
      return { outboxId: attempting.id, outcome: "failed" };
    }

    return this.markAmbiguous(
      attempting,
      claim.claimToken,
      `transport_unknown:${result.reason}`,
      undefined,
      result.providerLogId,
    );
  }

  /**
   * Waits for deployment-wide provider capacity without tying the lease length
   * to replica count or backlog size. Renewals are serialized: when this method
   * returns, no heartbeat write can race the final guard or send marker.
   *
   * Losing the token ends this dispatch immediately. The already-started
   * limiter promise has both outcomes handled, so it cannot leak an unhandled
   * rejection if it settles after ownership was lost.
   */
  private async waitForSendSlotWithClaimHeartbeat(
    claim: FeedbackOutboxClaimedRow,
  ): Promise<boolean> {
    const sendSlot: Promise<FeedbackSendSlotResult> = this.sendLimiter
      .waitTurn()
      .then(
        () => ({ state: "granted" }) as const,
        (error: unknown) => ({ state: "failed", error }) as const,
      );
    let heartbeatTimer: NodeJS.Timeout | undefined;

    try {
      while (true) {
        const heartbeatDue = new Promise<{ readonly state: "heartbeat" }>(
          (resolve) => {
            heartbeatTimer = setTimeout(
              () => resolve({ state: "heartbeat" }),
              FEEDBACK_OUTBOX_DISPATCH_HEARTBEAT_MS,
            );
            heartbeatTimer.unref();
          },
        );
        const event = await Promise.race([sendSlot, heartbeatDue]);
        clearTimeout(heartbeatTimer);
        heartbeatTimer = undefined;

        if (event.state === "failed") {
          throw event.error;
        }

        const renewed = await this.outbox.renewDispatchClaim(
          claim.id,
          claim.claimToken,
          new Date(),
        );
        if (!renewed) {
          return false;
        }
        if (event.state === "granted") {
          return true;
        }
      }
    } finally {
      if (heartbeatTimer) {
        clearTimeout(heartbeatTimer);
      }
    }
  }

  /**
   * Re-checks every mutable kill switch. Bot rows are cancelled after takeover;
   * `staff` rows are the human's own message and remain valid under that same
   * control state. Only completion/decline copy and STOP acknowledgement are
   * allowed through after their corresponding terminal transition.
   */
  private async guardCurrentState(
    claim: FeedbackOutboxClaimedRow,
    transaction?: AppTransaction,
    lockedCampaign?: FeedbackCampaignRow | null,
    lockedPhoneAtLaunch?: string,
  ): Promise<FeedbackOutboxGuardResult> {
    const executor = transaction ? ([transaction] as const) : [];
    const campaign =
      lockedCampaign === undefined
        ? await this.campaigns.findCampaignById(claim.campaignId, transaction)
        : (lockedCampaign ?? undefined);
    if (!campaign) {
      const failed = await this.outbox.finishDispatchClaimBeforeAttempt(
        claim.id,
        claim.claimToken,
        "failed",
        new Date(),
        "campaign_missing",
        ...executor,
      );
      return settled(claim.id, failed ? "failed" : "claim_lost");
    }

    const conversation = await this.conversations.findById(
      claim.conversationId,
    );
    if (!conversation) {
      const failed = await this.outbox.finishDispatchClaimBeforeAttempt(
        claim.id,
        claim.claimToken,
        "failed",
        new Date(),
        "conversation_missing",
        ...executor,
      );
      return settled(claim.id, failed ? "failed" : "claim_lost");
    }

    if (
      lockedPhoneAtLaunch !== undefined &&
      conversation.phoneAtLaunch !== lockedPhoneAtLaunch
    ) {
      const failed = await this.outbox.finishDispatchClaimBeforeAttempt(
        claim.id,
        claim.claimToken,
        "failed",
        new Date(),
        "conversation_route_changed",
        ...executor,
      );
      return settled(claim.id, failed ? "failed" : "claim_lost");
    }

    // Terminal copy is inserted before MongoDB commits the corresponding close.
    // It must wait for that aggregate transition; otherwise a superseded or
    // failed close can leak a final message into an open conversation.
    if (
      conversation.lifecycle.state === "open" &&
      isCanonicalTerminalTransitionMessage(claim)
    ) {
      const released = await this.outbox.releaseDispatchClaim(
        claim.id,
        claim.claimToken,
        new Date(),
        "terminal_transition_pending",
        ...executor,
      );
      return settled(claim.id, released ? "held" : "claim_lost");
    }

    const permittedStopAcknowledgement =
      conversation.lifecycle.state === "closed" &&
      isPermittedStopAcknowledgement(
        claim,
        conversation.lifecycle.reason,
        conversation.lifecycle.terminalOutboxId,
      );
    const permittedTerminalMessage =
      conversation.lifecycle.state === "closed" &&
      isPermittedTerminalMessage(
        claim,
        conversation.lifecycle.reason,
        conversation.lifecycle.terminalOutboxId,
      );

    // STOP revokes consent and closes independently of campaign state. Its
    // exact lifecycle-anchored acknowledgement is therefore the sole
    // automated row allowed through a concurrent pause/close. A dedupe-shaped
    // impostor receives no exception.
    if (campaign.status === "closed" && !permittedStopAcknowledgement) {
      const cancelled = await this.outbox.finishDispatchClaimBeforeAttempt(
        claim.id,
        claim.claimToken,
        "cancelled",
        new Date(),
        "campaign_closed",
        ...executor,
      );
      return settled(claim.id, cancelled ? "cancelled" : "claim_lost");
    }

    if (campaign.status === "paused" && !permittedStopAcknowledgement) {
      const released = await this.outbox.releaseDispatchClaim(
        claim.id,
        claim.claimToken,
        new Date(),
        "campaign_paused",
        ...executor,
      );
      return settled(claim.id, released ? "held" : "claim_lost");
    }
    if (
      conversation.lifecycle.state === "closed" &&
      !permittedTerminalMessage
    ) {
      const cancelled = await this.outbox.finishDispatchClaimBeforeAttempt(
        claim.id,
        claim.claimToken,
        "cancelled",
        new Date(),
        `conversation_closed:${conversation.lifecycle.reason ?? "unknown"}`,
        ...executor,
      );
      return settled(claim.id, cancelled ? "cancelled" : "claim_lost");
    }

    if (
      claim.kind !== "staff" &&
      !permittedTerminalMessage &&
      conversation.control.mode === "human"
    ) {
      const cancelled = await this.outbox.finishDispatchClaimBeforeAttempt(
        claim.id,
        claim.claimToken,
        "cancelled",
        new Date(),
        "human_control",
        ...executor,
      );
      return settled(claim.id, cancelled ? "cancelled" : "claim_lost");
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
        const failed = await this.outbox.finishDispatchClaimBeforeAttempt(
          claim.id,
          claim.claimToken,
          "failed",
          new Date(),
          "participant_missing",
          ...executor,
        );
        return settled(claim.id, failed ? "failed" : "claim_lost");
      }
      if (!participant.postEventFeedbackWhatsappOptIn) {
        const cancelled = await this.outbox.finishDispatchClaimBeforeAttempt(
          claim.id,
          claim.claimToken,
          "cancelled",
          new Date(),
          "consent_withdrawn",
          ...executor,
        );
        return settled(claim.id, cancelled ? "cancelled" : "claim_lost");
      }
    }

    if (
      conversation.awaitingHuman &&
      claim.kind !== "staff" &&
      !permittedTerminalMessage &&
      !isCurrentAwaitingHumanCommitment(claim.id, conversation)
    ) {
      const cancelled = await this.outbox.finishDispatchClaimBeforeAttempt(
        claim.id,
        claim.claimToken,
        "cancelled",
        new Date(),
        "awaiting_human",
        ...executor,
      );
      return settled(claim.id, cancelled ? "cancelled" : "claim_lost");
    }

    if (
      transaction &&
      claim.kind === "reply" &&
      !permittedTerminalMessage &&
      !isCurrentAwaitingHumanCommitment(claim.id, conversation)
    ) {
      const staleReason = await this.ordinaryExtractionReplyStaleReason(
        claim,
        conversation,
        transaction,
      );
      if (staleReason) {
        const cancelled = await this.outbox.finishDispatchClaimBeforeAttempt(
          claim.id,
          claim.claimToken,
          "cancelled",
          new Date(),
          staleReason,
          transaction,
        );
        return settled(claim.id, cancelled ? "cancelled" : "claim_lost");
      }
    }

    return {
      state: "ready",
      phoneAtLaunch: conversation.phoneAtLaunch,
      authorizedStopOutboxId: permittedStopAcknowledgement ? claim.id : null,
    };
  }

  /**
   * Final ordinary-reply fence. The immutable decision log says which Mongo
   * transcript the model answered; the phone lock makes the PostgreSQL ingress
   * comparison include every webhook acknowledgement that won before provider
   * entry, even when materialization has not reached MongoDB yet.
   */
  private async ordinaryExtractionReplyStaleReason(
    claim: FeedbackOutboxClaimedRow,
    conversation: FeedbackConversationDocument,
    transaction: AppTransaction,
  ): Promise<string | undefined> {
    const extraction = await this.readOrdinaryExtractionSnapshot(
      claim.id,
      transaction,
    );
    if (extraction.state === "not_ordinary") return undefined;
    if (extraction.state === "invalid") return "outbound_snapshot_invalid";

    const snapshotSeq = extraction.snapshot.latestMessageSeq ?? 0;
    const newerMongoTestimony = conversation.messages.some(
      (message) => message.actor === "participant" && message.seq > snapshotSeq,
    );
    if (newerMongoTestimony) return "superseded_by_newer_testimony";

    const snapshotWork = extraction.snapshot.work;
    const snapshotControlChangedAt = extraction.snapshot.control.changedAt;
    if (!snapshotWork || !snapshotControlChangedAt) {
      // Historical rows can still be inspected, but cannot prove that bot
      // control did not leave and return while their provider call was queued.
      return "outbound_snapshot_invalid";
    }

    const currentWork = resolveFeedbackConversationWork(conversation.work);
    const controlGenerationChanged =
      conversation.control.mode !== extraction.snapshot.control.mode ||
      conversation.control.source !== extraction.snapshot.control.source ||
      conversation.control.changedAt.toISOString() !== snapshotControlChangedAt;
    const executionGenerationChanged =
      currentWork.executionEpoch !== snapshotWork.executionEpoch;
    const campaignResumeGenerationChanged =
      (currentWork.campaignResumeGeneration ?? null) !==
      snapshotWork.campaignResumeGeneration;
    // A healthy execution may persist its row at revision N and then settle a
    // future reminder as N+1. Anything outside that narrow diagnostic range is
    // definitely not the work generation which produced this decision; exact
    // ABA authorization comes from control/resume/epoch above, not this range.
    const impossibleWorkRevision =
      currentWork.revision < snapshotWork.revision ||
      currentWork.revision > snapshotWork.revision + 1;
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
        // Historical log rows predate this field. An empty set deliberately
        // fails closed: an old unsent reply has no evidence that any durable
        // inbound belongs to its model snapshot.
        snapshotIngressIds: extraction.snapshot.participantIngressIds ?? [],
      },
    );
    return newerDurableIngress ? "superseded_by_newer_testimony" : undefined;
  }

  private async readOrdinaryExtractionSnapshot(
    outboxId: string,
    transaction: AppTransaction,
  ): Promise<OrdinaryExtractionSnapshot> {
    const log = await this.outboundLogs.findLogByOutboxId(
      outboxId,
      transaction,
    );
    if (!log || log.origin !== "extraction_reply") {
      return { state: "not_ordinary" };
    }

    const decision = feedbackOutboundDecisionSchema.safeParse(log.decision);
    if (!decision.success || decision.data.origin !== "extraction_reply") {
      return { state: "invalid" };
    }
    if (decision.data.closingReason !== null) {
      return { state: "not_ordinary" };
    }

    const snapshot = outboundConversationSnapshotSchema.safeParse(
      log.conversationState,
    );
    return snapshot.success
      ? { state: "snapshot", snapshot: snapshot.data }
      : { state: "invalid" };
  }

  private async markAmbiguous(
    row: MessageOutboxRow,
    claimToken: string,
    reason: string,
    error?: unknown,
    providerLogId?: string,
  ): Promise<FeedbackOutboxDispatchItemResult> {
    const ambiguous = await this.database.transaction(async (transaction) => {
      await this.outbox.lockConversation(transaction, row.conversationId);
      const marked = await this.outbox.markDispatchAmbiguous(
        row.id,
        claimToken,
        new Date(),
        boundedFailure(reason),
        providerLogId,
        transaction,
      );
      if (!marked) return undefined;
      // Status first, projection second, under the same mutex provider
      // observations use. A proven `sent` row therefore cannot acquire a false
      // human handoff in the old pre-CAS window; projection failure rolls the
      // transaction back to `attempting` for expiry maintenance to retry.
      await this.parkUncertainDelivery(marked, transaction);
      return marked;
    });
    this.logger.warn({
      event: "feedback.outbox.dispatch_ambiguous",
      outboxId: row.id,
      reason,
      hasProviderLogId: Boolean(providerLogId),
      ...(error
        ? { error: { name: error instanceof Error ? error.name : "Error" } }
        : {}),
      fenceHeld: Boolean(ambiguous),
    });
    return {
      outboxId: row.id,
      outcome: ambiguous ? "ambiguous" : "claim_lost",
    };
  }

  private async parkUncertainDelivery(
    row: MessageOutboxRow,
    transaction: AppTransaction,
  ): Promise<void> {
    const at = new Date();
    const conversation = await this.conversations.findById(row.conversationId);
    const terminalOutboxId =
      conversation?.lifecycle.state === "closed" &&
      conversation.lifecycle.reason === "stopped"
        ? (conversation.lifecycle.terminalOutboxId ?? null)
        : null;
    // Unknown delivery revokes every later bot-owned row while it is still
    // safely retractable. Otherwise the generic awaiting-human exception could
    // mistake a newer pre-recorded bot turn for an authorized commitment and
    // send it behind the ambiguous message. The exact terminal lifecycle row
    // survives: STOP may have won this same mutex immediately before the
    // attempt became ambiguous, and its acknowledgement remains owed.
    await this.outbox.cancelQueuedAutomatedOutboxForConversation(
      transaction,
      row.conversationId,
      terminalOutboxId,
    );
    if (!conversation) return;

    if (
      conversation.lifecycle.state === "open" &&
      conversation.control.mode === "bot" &&
      !conversation.awaitingHuman
    ) {
      await this.conversations.markAwaitingHuman({
        conversationId: row.conversationId,
        at,
      });
    }
    await this.conversations.raiseAttention({
      conversationId: row.conversationId,
      kind: "undelivered_message",
      messageId: null,
      at,
    });
  }

  private logQuarantineProjectionFailure(
    row: MessageOutboxRow,
    error: unknown,
  ): void {
    this.logger.error({
      event: "feedback.outbox.quarantine_projection_failed",
      outboxId: row.id,
      conversationId: row.conversationId,
      error: { name: error instanceof Error ? error.name : "Error" },
    });
  }

  private async raiseUndeliveredAttention(
    row: MessageOutboxRow,
  ): Promise<void> {
    try {
      await this.conversations.raiseAttention({
        conversationId: row.conversationId,
        kind: "undelivered_message",
        messageId: null,
        at: new Date(),
      });
    } catch (error) {
      // The failed outbox row is authoritative. Mongo attention is a useful
      // operator projection, never a reason to replay a rejected provider send.
      this.logger.error({
        event: "feedback.outbox.dispatch_attention_failed",
        outboxId: row.id,
        error: { name: error instanceof Error ? error.name : "Error" },
      });
    }
  }

  private logFenceLoss(outboxId: string, providerOutcome: string): void {
    this.logger.warn({
      event: "feedback.outbox.dispatch_fence_lost",
      outboxId,
      providerOutcome,
    });
  }
}

function boundedFailure(reason: string): string {
  const normalized = reason.trim() || "dispatch_failure";
  return normalized.slice(0, 2_000);
}

function settled(
  outboxId: string,
  outcome: FeedbackOutboxDispatchOutcome,
): Extract<FeedbackOutboxGuardResult, { readonly state: "settled" }> {
  return { state: "settled", result: { outboxId, outcome } };
}

function groupClaimsByConversation(
  claims: readonly FeedbackOutboxClaimedRow[],
): FeedbackOutboxClaimedRow[][] {
  const groups = new Map<string, FeedbackOutboxClaimedRow[]>();
  for (const claim of claims) {
    const existing = groups.get(claim.conversationId);
    if (existing) {
      existing.push(claim);
    } else {
      groups.set(claim.conversationId, [claim]);
    }
  }
  for (const group of groups.values()) {
    group.sort(
      (left, right) =>
        left.createdAt.getTime() - right.createdAt.getTime() ||
        left.id.localeCompare(right.id),
    );
  }
  return [...groups.values()];
}

/**
 * Closing copy is written before the aggregate closes and therefore dispatches
 * afterward. STOP acknowledgement is the analogous `system` row. Every other
 * row is stale once the conversation is terminal.
 */
function isPermittedTerminalMessage(
  row: Pick<
    FeedbackOutboxClaimedRow,
    "id" | "conversationId" | "kind" | "dedupeKey"
  >,
  reason: string | null,
  terminalOutboxId: string | null | undefined,
): boolean {
  if (isPermittedStopAcknowledgement(row, reason, terminalOutboxId)) {
    return true;
  }
  if (reason === "completed" || reason === "declined") {
    return (
      row.kind === "reply" &&
      terminalOutboxId === row.id &&
      isFeedbackClosingDedupeKey(row.conversationId, row.dedupeKey)
    );
  }
  return false;
}

function isCanonicalTerminalTransitionMessage(
  row: Pick<FeedbackOutboxClaimedRow, "conversationId" | "kind" | "dedupeKey">,
): boolean {
  return (
    (row.kind === "reply" &&
      isFeedbackClosingDedupeKey(row.conversationId, row.dedupeKey)) ||
    (row.kind === "system" &&
      row.dedupeKey === createFeedbackStopAckDedupeKey(row.conversationId))
  );
}

function isPermittedStopAcknowledgement(
  row: Pick<
    FeedbackOutboxClaimedRow,
    "id" | "conversationId" | "kind" | "dedupeKey"
  >,
  reason: string | null,
  terminalOutboxId: string | null | undefined,
): boolean {
  return (
    reason === "stopped" &&
    row.kind === "system" &&
    terminalOutboxId === row.id &&
    row.dedupeKey === createFeedbackStopAckDedupeKey(row.conversationId)
  );
}
