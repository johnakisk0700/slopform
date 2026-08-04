import { Injectable, Logger } from "@nestjs/common";
import type {
  AppTransaction,
  MessageOutboxRow,
  ProviderMessageIngressRow,
} from "@join-the-six/database";
import { AuditRepository } from "../../../infrastructure/audit/audit.repository.js";
import { DatabaseService } from "../../../infrastructure/database/database.service.js";
import { FeedbackCampaignRepository } from "../campaign/campaign.repository.js";
import { FeedbackIngressRepository } from "./ingress.repository.js";
import { FeedbackOutboxRepository } from "../outbox/outbox.repository.js";
import { FeedbackOutboundLogService } from "../outbox/outbound-log.service.js";
import {
  FeedbackConversationCapacityError,
  FeedbackConversationRepository,
} from "../post-event-feedback-conversation.repository.js";
import {
  FEEDBACK_CONVERSATION_MESSAGE_MAX_TEXT_LENGTH,
  deriveFeedbackStopAckOutboxId,
  type FeedbackConversationDocument,
} from "../post-event-feedback-conversation.document.js";
import { ParticipantsRepository } from "../../participants/participants.repository.js";
import { FeedbackOutboundTranscriptService } from "../outbox/outbound-transcript.service.js";
import { currentAwaitingHumanCommitmentOutboxId } from "../outbox/current-commitment.js";
import { coalesceDeliveryStatus } from "../outbox/delivery-status.js";
import {
  PostEventFeedbackMetrics,
  type FeedbackMaterializeOutcome,
} from "../metrics.service.js";
import {
  createFeedbackMediaNoticeDedupeKey,
  createFeedbackStopAckDedupeKey,
  fitToTranscript,
  resolveCampaignCopy,
} from "../question-set.js";
import { matchesPostEventFeedbackStopCommand } from "../matching/stop-command.js";
import {
  FEEDBACK_EXTRACT_QUIET_WINDOW_MS,
  isFeedbackEditedProviderMessageId,
} from "../jobs.schemas.js";
import { PostEventFeedbackCampaignSummaryService } from "../summary/summary.service.js";
import { FeedbackConversationWakeupService } from "../reconciliation/wakeup.service.js";

export class PostEventFeedbackIngressNotFoundError extends Error {
  constructor(ingressId: string) {
    super(`Provider message ingress ${ingressId} was not found`);
    this.name = PostEventFeedbackIngressNotFoundError.name;
  }
}

export interface MaterializeFeedbackIngressInput {
  readonly ingressId: string;
  readonly correlationId: string;
}

export interface MaterializeFeedbackIngressResult {
  readonly outcome: FeedbackMaterializeOutcome;
  readonly conversationId?: string;
  readonly extractJobId?: string;
  readonly stopAckOutboxId?: string;
  readonly correlatedOutboxId?: string;
}

/**
 * The durable consumer behind the webhook (D7). It reloads every authoritative
 * fact, resolves the conversation through the Mongo partial unique index (D9),
 * keeps unmatched shared-session traffic metadata-only (D10), applies STOP
 * deterministically before any AI (D14) and correlates observed outbound
 * messages to the outbox, treating an uncorrelated one as external channel
 * activity (D17).
 *
 * Every step is replay-safe. Cross-store work always moves forward — MongoDB
 * first, then the PostgreSQL fence that marks the ingress row terminal — so a
 * crash re-runs an idempotent no-op instead of losing or duplicating an effect.
 */
@Injectable()
export class PostEventFeedbackMaterializer {
  private readonly logger = new Logger(PostEventFeedbackMaterializer.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly campaigns: FeedbackCampaignRepository,
    private readonly ingress: FeedbackIngressRepository,
    private readonly outbox: FeedbackOutboxRepository,
    private readonly conversations: FeedbackConversationRepository,
    private readonly participants: ParticipantsRepository,
    private readonly audit: AuditRepository,
    private readonly metrics: PostEventFeedbackMetrics,
    private readonly outboundTranscript: FeedbackOutboundTranscriptService,
    private readonly outboundLog: FeedbackOutboundLogService,
    private readonly summaries: PostEventFeedbackCampaignSummaryService,
    private readonly wakeups: FeedbackConversationWakeupService,
  ) {}

  async materialize(
    input: MaterializeFeedbackIngressInput,
  ): Promise<MaterializeFeedbackIngressResult> {
    const ingress = await this.ingress.findIngressById(input.ingressId);
    if (!ingress) {
      throw new PostEventFeedbackIngressNotFoundError(input.ingressId);
    }

    if (ingress.processingStatus !== "pending") {
      return this.complete(
        { outcome: "already_processed" },
        input.correlationId,
      );
    }

    const conversation = ingress.phoneE164
      ? await this.conversations.findOpenByPhone(ingress.phoneE164)
      : undefined;

    if (ingress.direction === "outbound") {
      // An outbound observation is worth correlating even without an open
      // conversation: a STOP acknowledgement is sent to a conversation that is
      // already closed, and recording it as unrelated traffic would both lose
      // its delivery state and inflate the unmatched counter.
      return this.materializeOutbound(
        ingress,
        conversation,
        input.correlationId,
      );
    }

    if (conversation) {
      return this.materializeInbound(
        ingress,
        conversation,
        input.correlationId,
      );
    }

    // Before calling it unmatched: the questionnaire may simply have ended.
    // Our own closing copy invites another message, and people take it up.
    const closed = ingress.phoneE164
      ? await this.conversations.findLatestClosedByPhone(ingress.phoneE164)
      : undefined;

    return closed
      ? this.materializePostClosure(ingress, closed, input.correlationId)
      : this.ignoreUnmatched(ingress, input.correlationId);
  }

  /**
   * Somebody wrote after their conversation had closed.
   *
   * Three things have to be true at once. The words survive, because this is
   * where a disclosure lands — last, once the person has warmed up, often in
   * reply to «Ό,τι άλλο θες να μας πεις». An operator finds out, because a
   * closed conversation is not on anyone's screen. And the bot stays silent:
   * the transcript records what happened, no extraction is queued, and a closed
   * thread never resumes the questionnaire on its own.
   *
   * STOP is the exception that still acts. Somebody who finished the
   * questionnaire and then decided they never want to hear from us again is
   * making a consent decision, and `close()` already lets `stopped` supersede
   * any other reason.
   *
   * Retention follows the campaign's own rule: a conversation the participant
   * ended with STOP keeps metadata only. They did not opt out of speaking to
   * us, but we do not retain what they said afterwards — and that restraint is
   * reversible in a way that storing is not.
   */
  private async materializePostClosure(
    ingress: ProviderMessageIngressRow,
    conversation: FeedbackConversationDocument,
    correlationId: string,
  ): Promise<MaterializeFeedbackIngressResult> {
    const text = ingress.text?.trim() ?? "";

    if (text.length > 0 && matchesPostEventFeedbackStopCommand(text)) {
      return this.applyStop(ingress, conversation, correlationId, null);
    }

    const retainsText = conversation.lifecycle.reason !== "stopped";
    let writtenMessageId: string | null = null;
    if (retainsText && text.length > 0) {
      try {
        const appended = await this.conversations.appendMessage({
          conversationId: conversation._id,
          actor: "participant",
          text: fitToTranscript(text).text,
          at: ingress.observedAt,
          providerMessageId: ingress.providerMessageId,
          ingressId: ingress.id,
        });
        writtenMessageId = appended.message.id;
      } catch (error) {
        if (!(error instanceof FeedbackConversationCapacityError)) {
          throw error;
        }
        this.logger.warn({
          event: "feedback.materialize.transcript_capacity",
          correlationId,
          ingressId: ingress.id,
          conversationId: conversation._id,
        });
      }
    }

    // Anchored on the turn that was just written, because the whole reason this
    // path raises at all is that nobody is watching a closed conversation and
    // this is the message they need to read. A STOP-closed thread keeps no text,
    // so there is nothing to link to and the reason says so.
    await this.conversations.raiseAttention({
      conversationId: conversation._id,
      kind: "post_closure_message",
      messageId: writtenMessageId,
      at: ingress.observedAt,
    });

    await this.withPendingIngress(ingress.id, async (transaction) => {
      await this.audit.append(transaction, {
        actorType: "participant",
        actorId: conversation.respondentParticipantId,
        action: "feedback_conversation.post_closure_message",
        entityType: "feedback_conversation",
        entityId: conversation._id,
        requestId: correlationId,
        context: {
          ingressId: ingress.id,
          campaignId: conversation.campaignId,
          closedBecause: conversation.lifecycle.reason,
          textRetained: retainsText,
        },
      });
      await this.ingress.updateIngressProcessing(transaction, ingress.id, {
        processingStatus: "materialized",
        matchedConversationId: conversation._id,
        ...(retainsText ? {} : { text: null }),
      });
    });

    this.logger.log({
      event: "feedback.materialize.post_closure",
      correlationId,
      ingressId: ingress.id,
      conversationId: conversation._id,
      closedBecause: conversation.lifecycle.reason,
      textRetained: retainsText,
    });

    return this.complete(
      {
        outcome: "inbound_materialized",
        conversationId: conversation._id,
      },
      correlationId,
    );
  }

  /**
   * D10: the shared WhatsApp session also carries WordPress-era and unrelated
   * traffic. Those rows keep provider metadata only, drop the body and are
   * never seen by extraction.
   */
  /**
   * Traffic on our WhatsApp session that belongs to no conversation we know of.
   *
   * D10 nulled the body here, on the reasoning that shared-session chatter is
   * not ours to keep. The reasoning holds for genuine strangers and fails for
   * the case that actually happens: somebody signed up with an old number,
   * replies from the new one, and «σόρρυ άλλαξα νούμερο. 5, ο Νίκος ήταν
   * φοβερός» is deleted on arrival — while their original conversation is
   * nudged at a number nobody reads and then expires. They answered; we
   * recorded a non-responder, twice over.
   *
   * The text is now kept on the durable ingress row and an operator is called.
   * That row is an audit boundary, not a published transcript: nothing about
   * this person is attributed to any participant, and a human decides whether
   * it belongs to somebody before it goes anywhere.
   */
  private async ignoreUnmatched(
    ingress: ProviderMessageIngressRow,
    correlationId: string,
  ): Promise<MaterializeFeedbackIngressResult> {
    const hasBody = (ingress.text?.trim().length ?? 0) > 0;

    await this.withPendingIngress(ingress.id, (transaction) =>
      this.ingress.updateIngressProcessing(transaction, ingress.id, {
        processingStatus: "ignored_unmatched",
        matchedConversationId: null,
      }),
    );

    if (hasBody && ingress.direction === "inbound") {
      this.logger.warn({
        event: "feedback.materialize.unmatched_inbound_retained",
        correlationId,
        ingressId: ingress.id,
        phoneE164: ingress.phoneE164,
      });
    }

    return this.complete({ outcome: "ignored_unmatched" }, correlationId);
  }

  private async materializeInbound(
    ingress: ProviderMessageIngressRow,
    conversation: FeedbackConversationDocument,
    correlationId: string,
  ): Promise<MaterializeFeedbackIngressResult> {
    const text = ingress.text?.trim() ?? "";
    if (text.length === 0) {
      // Media, reactions and stickers have no transcript representation yet.
      // The durable row keeps the provider metadata for an operator.
      return this.flagUnmaterializedInbound(
        ingress,
        conversation,
        correlationId,
        "empty_body",
      );
    }

    const stopRequested = matchesPostEventFeedbackStopCommand(text);
    const rendered = fitToTranscript(text);
    let writtenMessageId: string;
    let materializedConversation: FeedbackConversationDocument;

    try {
      const appended = await this.conversations.appendMessage({
        conversationId: conversation._id,
        actor: "participant",
        text: rendered.text,
        at: ingress.observedAt,
        providerMessageId: ingress.providerMessageId,
        ingressId: ingress.id,
      });
      writtenMessageId = appended.message.id;
      materializedConversation = appended.conversation;
    } catch (error) {
      if (!(error instanceof FeedbackConversationCapacityError)) {
        throw error;
      }
      return this.flagUnmaterializedInbound(
        ingress,
        conversation,
        correlationId,
        "transcript_capacity",
      );
    }

    // The whole message is in the ingress row; only the rendered copy was cut.
    // Saying so is the point — a truncation nobody is told about reads in the
    // admin as the complete message, and the part that did not fit is the part
    // people build up to.
    if (rendered.truncated) {
      await this.conversations.raiseAttention({
        conversationId: conversation._id,
        kind: "transcript_mismatch",
        messageId: writtenMessageId,
        at: ingress.observedAt,
      });
      this.logger.warn({
        event: "feedback.materialize.transcript_truncated",
        correlationId,
        ingressId: ingress.id,
        conversationId: conversation._id,
        originalLength: text.length,
      });
    }

    // An edited redelivery reaches the transcript as its own turn, so both
    // versions are readable. Which one the participant meant is a judgement for
    // a person — «ο Κώστας ήταν χάλια» corrected to «ο Κώστας τελικά ήταν οκ»
    // is about a real participant, and neither silently overwriting the first
    // nor silently keeping it is ours to decide.
    //
    // Same reason kind as a truncation on purpose: both say the transcript is
    // not what arrived, and the operator does the same thing about either —
    // open this message and read what the participant actually sent. A message
    // that was both cut and edited is therefore one row to dismiss, not two.
    if (isFeedbackEditedProviderMessageId(ingress.providerMessageId)) {
      await this.conversations.raiseAttention({
        conversationId: conversation._id,
        kind: "transcript_mismatch",
        messageId: writtenMessageId,
        at: ingress.observedAt,
      });
      this.logger.warn({
        event: "feedback.materialize.edited_redelivery",
        correlationId,
        ingressId: ingress.id,
        conversationId: conversation._id,
      });
    }

    if (stopRequested) {
      return this.applyStop(
        ingress,
        conversation,
        correlationId,
        writtenMessageId,
      );
    }

    // Enqueued before the ingress row becomes terminal: a crash in between
    // replays the whole job, whereas the reverse order would lose the run.
    const extractJobId = await this.enqueueExtraction(
      conversation._id,
      correlationId,
      ingress.observedAt,
    );

    const currentHandoffOutboxId = currentAwaitingHumanCommitmentOutboxId(
      materializedConversation,
    );
    const terminalOutboxId =
      materializedConversation.lifecycle.state === "closed"
        ? (materializedConversation.lifecycle.terminalOutboxId ?? null)
        : null;
    await this.withPendingIngress(
      ingress.id,
      async (transaction) => {
        // A participant turn supersedes questionnaire copy that has not crossed
        // provider entry. Hold the same mutex as the dispatcher's final marker,
        // while retaining only exact Mongo-authorized handoff/terminal promises
        // plus system and staff rows (which the repository excludes by kind).
        await this.outbox.cancelQueuedSupersededAutomationForConversation(
          transaction,
          conversation._id,
          [currentHandoffOutboxId, terminalOutboxId].filter(
            (id): id is string => id !== null,
          ),
        );
        await this.ingress.updateIngressProcessing(transaction, ingress.id, {
          processingStatus: "materialized",
          matchedConversationId: conversation._id,
        });
      },
      conversation._id,
    );

    return this.complete(
      {
        outcome: "inbound_materialized",
        conversationId: conversation._id,
        extractJobId,
      },
      correlationId,
    );
  }

  /**
   * D14: STOP is deterministic, checked before any model call and effective in
   * both control modes. The conversation closes first so no writer can speak
   * again, then PostgreSQL cancels queued sends, records the single
   * acknowledgement, withdraws the opt-in and audits the whole transition.
   */
  private async applyStop(
    ingress: ProviderMessageIngressRow,
    conversation: FeedbackConversationDocument,
    correlationId: string,
    /**
     * The transcript turn carrying the STOP, when there is one. A STOP that
     * arrives after closure is never written to the transcript, so that path
     * has nothing to anchor on and passes `null` rather than inventing a link.
     */
    stopMessageId: string | null,
  ): Promise<MaterializeFeedbackIngressResult> {
    const applied = await this.withPendingIngress(
      ingress.id,
      async (transaction) => {
        // The acknowledgement row exists before the lifecycle CAS so MongoDB
        // can authorize its exact id. If this transaction later rolls back,
        // the open lifecycle cannot make the uncommitted row visible; if the
        // cross-store close commits first and PostgreSQL fails, ingress replay
        // recreates the same row through its dedupe key.
        const campaign = await this.campaigns.findCampaignByIdForShare(
          transaction,
          conversation.campaignId,
        );
        const stopAck = await this.outbox.insertOutboxIfAbsent(transaction, {
          id: deriveFeedbackStopAckOutboxId(conversation._id),
          conversationId: conversation._id,
          campaignId: conversation.campaignId,
          kind: "system",
          body: resolveCampaignCopy(
            campaign?.questions,
            campaign?.questionSetVersion,
          ).stop_ack.slice(0, FEEDBACK_CONVERSATION_MESSAGE_MAX_TEXT_LENGTH),
          dedupeKey: createFeedbackStopAckDedupeKey(conversation._id),
        });
        const closed = await this.conversations.close({
          conversationId: conversation._id,
          reason: "stopped",
          at: ingress.observedAt,
          terminalOutboxId: stopAck.row.id,
        });

        // Somebody who opts out without having answered a single question is
        // the shape of a number that changed hands: a stranger is being asked
        // about a dinner they were never at. The reason is durable and
        // idempotent, so holding the shared conversation lock across this Mongo
        // write and the PostgreSQL cancellation is safe on replay.
        const answeredNothing = conversation.goals.every(
          (goal) => goal.status !== "answered",
        );
        if (answeredNothing) {
          await this.conversations.raiseAttention({
            conversationId: conversation._id,
            kind: "stopped_without_answers",
            messageId: stopMessageId,
            at: ingress.observedAt,
          });
        }

        const cancelledOutboxCount =
          await this.outbox.cancelQueuedOutboxForConversationExceptId(
            transaction,
            conversation._id,
            stopAck.row.id,
          );
        await this.outboundLog.record(transaction, {
          outbox: stopAck,
          conversation,
          decision: {
            origin: "stop_ack",
            sourceIngressId: ingress.id,
          },
          correlationId,
        });

        const optInWithdrawn = await this.withdrawFeedbackOptIn(
          transaction,
          conversation,
          correlationId,
        );

        await this.audit.append(transaction, {
          actorType: "participant",
          actorId: conversation.respondentParticipantId,
          action: "feedback_conversation.stopped",
          entityType: "feedback_conversation",
          entityId: conversation._id,
          requestId: correlationId,
          context: {
            ingressId: ingress.id,
            campaignId: conversation.campaignId,
            cancelledOutboxCount,
            stopAckOutboxId: stopAck.row.id,
            optInWithdrawn,
          },
        });

        await this.ingress.updateIngressProcessing(transaction, ingress.id, {
          processingStatus: "materialized",
          matchedConversationId: conversation._id,
        });

        return { stopAck: stopAck.row, closed: closed.changed };
      },
      conversation._id,
    );

    if (applied) {
      await this.summaries.notifyIfLastConversationClosed(
        conversation.campaignId,
        correlationId,
        applied.closed,
      );
      // Appends are allowed on a closed conversation: the transcript records
      // what actually happened, and the acknowledgement is observed after the
      // closure. A crash here cannot be repaired by a replay — the fence above
      // already marked the ingress row terminal — so the WP6 delivery job
      // re-runs this same idempotent append before it sends.
      await this.outboundTranscript.record(
        applied.stopAck,
        ingress.observedAt,
        correlationId,
      );
    }

    return this.complete(
      {
        outcome: "inbound_stopped",
        conversationId: conversation._id,
        ...(applied ? { stopAckOutboxId: applied.stopAck.id } : {}),
      },
      correlationId,
    );
  }

  private async withdrawFeedbackOptIn(
    transaction: AppTransaction,
    conversation: FeedbackConversationDocument,
    correlationId: string,
  ): Promise<boolean> {
    const participant = await this.participants.findByIdForUpdate(
      transaction,
      conversation.respondentParticipantId,
    );
    if (!participant?.postEventFeedbackWhatsappOptIn) {
      return false;
    }

    await this.participants.updateFeedbackOptIn(
      transaction,
      participant.id,
      false,
    );
    await this.audit.append(transaction, {
      actorType: "participant",
      actorId: participant.id,
      action: "participant.feedback_whatsapp_opt_in_changed",
      entityType: "participant",
      entityId: participant.id,
      requestId: correlationId,
      context: {
        from: true,
        to: false,
        reason: "stop_command",
        conversationId: conversation._id,
      },
    });

    return true;
  }

  /**
   * An observed outbound is either one of our own outbox rows coming back from
   * the provider — which only updates delivery columns, because the outbox owns
   * that message's transcript entry — or genuine external channel activity,
   * which silences the bot until an explicit resume (D17).
   */
  private async materializeOutbound(
    ingress: ProviderMessageIngressRow,
    conversation: FeedbackConversationDocument | undefined,
    correlationId: string,
  ): Promise<MaterializeFeedbackIngressResult> {
    const correlated = await this.findCorrelatedOutbox(ingress, conversation);

    if (correlated) {
      await this.withPendingIngress(
        ingress.id,
        async (transaction) => {
          await this.outbox.updateOutboxDelivery(transaction, correlated.id, {
            deliveryStatus: coalesceDeliveryStatus(
              correlated.deliveryStatus,
              "sent",
            ),
            providerMessageId: ingress.providerMessageId,
            sentAt: correlated.sentAt ?? ingress.observedAt,
            ...(correlated.status === "pending" ||
            correlated.status === "claimed" ||
            correlated.status === "attempting" ||
            correlated.status === "ambiguous" ||
            correlated.status === "sending" ||
            correlated.status === "sent"
              ? { status: "sent" as const }
              : {}),
          });
          await this.ingress.updateIngressProcessing(transaction, ingress.id, {
            processingStatus: "materialized",
            matchedConversationId: correlated.conversationId,
          });
        },
        correlated.conversationId,
      );

      return this.complete(
        {
          outcome: "outbound_correlated",
          conversationId: correlated.conversationId,
          correlatedOutboxId: correlated.id,
        },
        correlationId,
      );
    }

    if (!conversation) {
      // Nothing of ours and nobody to silence: the shared session is simply
      // being used for something else.
      return this.ignoreUnmatched(ingress, correlationId);
    }

    await this.withPendingIngress(
      ingress.id,
      async (transaction) => {
        const takeover = await this.conversations.takeOver({
          conversationId: conversation._id,
          source: "external_outbound",
          at: ingress.observedAt,
        });
        const cancelledOutboxCount = takeover.changed
          ? await this.outbox.cancelQueuedAutomatedOutboxForConversation(
              transaction,
              conversation._id,
            )
          : 0;

        const text = ingress.text?.trim() ?? "";
        if (text.length > 0) {
          try {
            await this.conversations.appendMessage({
              conversationId: conversation._id,
              actor: "staff",
              text,
              at: ingress.observedAt,
              providerMessageId: ingress.providerMessageId,
              ingressId: ingress.id,
            });
          } catch (error) {
            if (!(error instanceof FeedbackConversationCapacityError)) {
              throw error;
            }
            this.logger.warn({
              event: "feedback.materialize.transcript_capacity",
              correlationId,
              ingressId: ingress.id,
              conversationId: conversation._id,
            });
          }
        }

        await this.audit.append(transaction, {
          actorType: "system",
          actorId: "wasender_observation",
          action: "feedback_conversation.external_outbound_observed",
          entityType: "feedback_conversation",
          entityId: conversation._id,
          requestId: correlationId,
          context: {
            ingressId: ingress.id,
            campaignId: conversation.campaignId,
            providerMessageId: ingress.providerMessageId,
            controlChanged: takeover.changed,
            cancelledOutboxCount,
          },
        });
        await this.ingress.updateIngressProcessing(transaction, ingress.id, {
          processingStatus: "materialized",
          matchedConversationId: conversation._id,
        });
      },
      conversation._id,
    );

    return this.complete(
      { outcome: "outbound_external", conversationId: conversation._id },
      correlationId,
    );
  }

  /**
   * The provider message id is authoritative once a send recorded it. Before
   * that — an ambiguous send, or a legacy delivery that crashed after the provider
   * accepted it — the fallback is the oldest unlinked row of the resolved
   * conversation with the exact same body. A provider id belonging to a
   * different conversation is not a match and is left to the takeover rule.
   */
  private async findCorrelatedOutbox(
    ingress: ProviderMessageIngressRow,
    conversation: FeedbackConversationDocument | undefined,
  ): Promise<MessageOutboxRow | undefined> {
    const byProviderMessageId = await this.outbox.findOutboxByProviderMessageId(
      ingress.providerMessageId,
    );
    if (byProviderMessageId) {
      return !conversation ||
        byProviderMessageId.conversationId === conversation._id
        ? byProviderMessageId
        : undefined;
    }

    const text = ingress.text?.trim() ?? "";
    if (!conversation || text.length === 0) {
      return undefined;
    }

    return this.outbox.findUnlinkedOutboxByConversationAndBody(
      conversation._id,
      text,
    );
  }

  private async flagUnmaterializedInbound(
    ingress: ProviderMessageIngressRow,
    conversation: FeedbackConversationDocument,
    correlationId: string,
    reason: "empty_body" | "transcript_capacity",
  ): Promise<MaterializeFeedbackIngressResult> {
    // Two situations, two names, because the operator does two different things.
    // A voice note is work they can finish — listen to it on the phone and
    // record the answer. A full transcript is not: nothing more can be written
    // here at all, which is why this path also hands the thread to a person.
    //
    // No anchor either way: nothing was appended, so there is no transcript line
    // to link to. The reason is about a message the transcript does not contain,
    // which is precisely what the operator has to be told.
    const attention = {
      conversationId: conversation._id,
      kind: reason === "empty_body" ? "unreadable_message" : "transcript_full",
      messageId: null,
      at: ingress.observedAt,
    } as const;

    // Say something, once. A body we cannot read used to produce pure silence:
    // the questionnaire simply stopped answering, so somebody dictating from
    // the car kept recording answers into a void and arrived in the campaign
    // list as a non-responder — while they had in fact answered everything.
    //
    // Only for `empty_body`. A full transcript is our problem, not theirs, and
    // asking them to retype something we simply have no room for would be a
    // lie about why we went quiet.
    let notice = { inserted: false };
    if (reason === "transcript_capacity") {
      // A full transcript disables the bot. Take the dispatcher's shared mutex
      // across that Mongo transition and the durable ingress fence so it cannot
      // slip between the final state read and provider-entry marker. A replay
      // that lost the PostgreSQL commit repeats idempotent Mongo writes.
      await this.withPendingIngress(
        ingress.id,
        async (transaction) => {
          await this.conversations.raiseAttention(attention);
          await this.conversations.markAwaitingHuman({
            conversationId: conversation._id,
            at: ingress.observedAt,
          });
          await this.outbox.cancelQueuedAutomatedOutboxForConversation(
            transaction,
            conversation._id,
          );
          await this.ingress.updateIngressProcessing(transaction, ingress.id, {
            processingStatus: "failed",
            matchedConversationId: conversation._id,
          });
        },
        conversation._id,
      );
    } else {
      await this.conversations.raiseAttention(attention);
      notice = await this.sendMediaNotice(ingress, conversation, correlationId);
      await this.withPendingIngress(ingress.id, (transaction) =>
        this.ingress.updateIngressProcessing(transaction, ingress.id, {
          processingStatus: "failed",
          matchedConversationId: conversation._id,
        }),
      );
    }

    this.logger.warn({
      event: "feedback.materialize.inbound_not_materialized",
      correlationId,
      ingressId: ingress.id,
      conversationId: conversation._id,
      reason,
      noticeSent: notice.inserted,
    });

    return this.complete(
      {
        outcome: "inbound_not_materialized",
        conversationId: conversation._id,
      },
      correlationId,
    );
  }

  /**
   * Tells a participant, exactly once per conversation, that we cannot read
   * what they just sent. The `dedupe_key` is what makes "once" true across a
   * burst of voice notes materializing in parallel.
   */
  private async sendMediaNotice(
    ingress: ProviderMessageIngressRow,
    conversation: FeedbackConversationDocument,
    correlationId: string,
  ): Promise<{ inserted: boolean }> {
    const campaign = await this.campaigns.findCampaignById(
      conversation.campaignId,
    );
    // The kill switch still governs: a paused campaign says nothing at all.
    if (campaign?.status !== "launched") {
      return { inserted: false };
    }

    const notice = await this.database.transaction(async (transaction) => {
      const result = await this.outbox.insertOutboxIfAbsent(transaction, {
        conversationId: conversation._id,
        campaignId: conversation.campaignId,
        kind: "system",
        body: resolveCampaignCopy(
          campaign.questions,
          campaign.questionSetVersion,
        ).cannot_read_media.slice(
          0,
          FEEDBACK_CONVERSATION_MESSAGE_MAX_TEXT_LENGTH,
        ),
        dedupeKey: createFeedbackMediaNoticeDedupeKey(conversation._id),
      });
      await this.outboundLog.record(transaction, {
        outbox: result,
        conversation,
        decision: {
          origin: "media_notice",
          sourceIngressId: ingress.id,
        },
        correlationId,
      });
      return result;
    });
    if (notice.inserted) {
      await this.outboundTranscript.record(
        notice.row,
        ingress.observedAt,
        correlationId,
      );
    }
    return { inserted: notice.inserted };
  }

  /**
   * The one place a model turn is born, and therefore the one place the quiet
   * window belongs. Everything upstream of here — the webhook, the ingress row,
   * this materialization — stays immediate on purpose: those are the durable
   * writes that fill the transcript while the window runs, so delaying them
   * would leave the window with nothing to collect.
   */
  private async enqueueExtraction(
    conversationId: string,
    correlationId: string,
    observedAt: Date,
  ): Promise<string> {
    return this.wakeups.schedule({
      conversationId,
      nextActionAt: new Date(
        observedAt.getTime() + FEEDBACK_EXTRACT_QUIET_WINDOW_MS,
      ),
      correlationId,
      at: observedAt,
    });
  }

  /**
   * Serializes concurrent materialize executions on the ingress row and keeps
   * every side effect of one delivery in a single transaction. A replay that
   * finds a terminal row performs nothing and reports no work.
   */
  private async withPendingIngress<T>(
    ingressId: string,
    work: (
      transaction: AppTransaction,
      ingress: ProviderMessageIngressRow,
    ) => Promise<T>,
    conversationLockId?: string,
  ): Promise<T | undefined> {
    return this.database.transaction(async (transaction) => {
      const row = await this.ingress.findIngressByIdForUpdate(
        transaction,
        ingressId,
      );
      if (!row || row.processingStatus !== "pending") {
        return undefined;
      }
      if (conversationLockId) {
        await this.outbox.lockConversation(transaction, conversationLockId);
      }
      return work(transaction, row);
    });
  }

  private complete(
    result: MaterializeFeedbackIngressResult,
    correlationId: string,
  ): MaterializeFeedbackIngressResult {
    this.metrics.recordMaterializeOutcome(result.outcome, correlationId);
    return result;
  }
}
