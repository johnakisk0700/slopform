import { InjectQueue } from "@nestjs/bullmq";
import { Injectable, Logger } from "@nestjs/common";
import type {
  AppTransaction,
  MessageOutboxRow,
  ProviderMessageIngressRow,
} from "@join-the-six/database";
import type { Queue } from "bullmq";

import { AuditRepository } from "../../infrastructure/audit/audit.repository.js";
import { DatabaseService } from "../../infrastructure/database/database.service.js";
import { FEEDBACK_QUEUE } from "../../infrastructure/queue/queue.constants.js";
import {
  FeedbackConversationCapacityError,
  FeedbackConversationRepository,
} from "../conversations/feedback-conversation.repository.js";
import {
  FEEDBACK_CONVERSATION_MESSAGE_MAX_STORED_TEXT_LENGTH,
  FEEDBACK_CONVERSATION_MESSAGE_MAX_TEXT_LENGTH,
  type FeedbackConversationDocument,
} from "../conversations/feedback-conversation.schemas.js";
import { ParticipantsRepository } from "../participants/participants.repository.js";
import { FeedbackOutboundTranscriptService } from "./feedback-outbound-transcript.service.js";
import { coalesceDeliveryStatus } from "./message-outbox-delivery-status.js";
import {
  PostEventFeedbackMetrics,
  type FeedbackMaterializeOutcome,
} from "./post-event-feedback-metrics.service.js";
import {
  createFeedbackMediaNoticeDedupeKey,
  POST_EVENT_FEEDBACK_QUESTION_SET_V1,
} from "./post-event-feedback-question-set.js";
import { matchesPostEventFeedbackStopCommand } from "./post-event-feedback-stop-matcher.js";
import { PostEventFeedbackRepository } from "./post-event-feedback.repository.js";
import {
  createFeedbackExtractJobId,
  FEEDBACK_EXTRACT_QUIET_WINDOW_MS,
  FEEDBACK_JOB_NAMES,
  FEEDBACK_JOB_SCHEMA_VERSION,
  feedbackExtractJobDataSchema,
  isFeedbackEditedProviderMessageId,
  type FeedbackJobData,
  type FeedbackJobName,
} from "./post-event-feedback.schemas.js";

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

export const FEEDBACK_STOP_ACK_DEDUPE_PREFIX = "feedback-stop-ack";

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
    @InjectQueue(FEEDBACK_QUEUE)
    private readonly queue: Queue<FeedbackJobData, void, FeedbackJobName>,
    private readonly database: DatabaseService,
    private readonly repository: PostEventFeedbackRepository,
    private readonly conversations: FeedbackConversationRepository,
    private readonly participants: ParticipantsRepository,
    private readonly audit: AuditRepository,
    private readonly metrics: PostEventFeedbackMetrics,
    private readonly outboundTranscript: FeedbackOutboundTranscriptService,
  ) {}

  async materialize(
    input: MaterializeFeedbackIngressInput,
  ): Promise<MaterializeFeedbackIngressResult> {
    const ingress = await this.repository.findIngressById(input.ingressId);
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
      return this.applyStop(ingress, conversation, correlationId);
    }

    const retainsText = conversation.lifecycle.reason !== "stopped";
    if (retainsText && text.length > 0) {
      try {
        await this.conversations.appendMessage({
          conversationId: conversation._id,
          actor: "participant",
          text: fitToTranscript(text).text,
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

    await this.conversations.setNeedsAttention({
      conversationId: conversation._id,
      needsAttention: true,
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
      await this.repository.updateIngressProcessing(transaction, ingress.id, {
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
      this.repository.updateIngressProcessing(transaction, ingress.id, {
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
    let latestSeq: number;

    try {
      const appended = await this.conversations.appendMessage({
        conversationId: conversation._id,
        actor: "participant",
        text: rendered.text,
        at: ingress.observedAt,
        providerMessageId: ingress.providerMessageId,
        ingressId: ingress.id,
      });
      latestSeq = appended.conversation.messages.length;
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
      await this.conversations.setNeedsAttention({
        conversationId: conversation._id,
        needsAttention: true,
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
    if (isFeedbackEditedProviderMessageId(ingress.providerMessageId)) {
      await this.conversations.setNeedsAttention({
        conversationId: conversation._id,
        needsAttention: true,
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
      return this.applyStop(ingress, conversation, correlationId);
    }

    // Enqueued before the ingress row becomes terminal: a crash in between
    // replays the whole job, whereas the reverse order would lose the run.
    const extractJobId = await this.enqueueExtraction(
      conversation._id,
      latestSeq,
      correlationId,
    );

    await this.withPendingIngress(ingress.id, async (transaction) => {
      await this.repository.updateIngressProcessing(transaction, ingress.id, {
        processingStatus: "materialized",
        matchedConversationId: conversation._id,
      });
    });

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
  ): Promise<MaterializeFeedbackIngressResult> {
    await this.conversations.close({
      conversationId: conversation._id,
      reason: "stopped",
      at: ingress.observedAt,
    });

    // Somebody who opts out without having answered a single question is the
    // shape of a number that changed hands: a stranger is being asked about a
    // dinner they were never at. It is also how a bad phone match and a
    // genuinely annoyed recipient look, and all three are worth one glance.
    //
    // Measured on goals rather than on messages, because the stranger does
    // reply — «ποιος είσαι ρε φίλε;» is a message and is not an answer. An
    // opt-out *after* answering is the ordinary healthy ending and is not
    // flagged: an inbox that fills up with every STOP is an inbox nobody reads.
    const answeredNothing = conversation.goals.every(
      (goal) => goal.status !== "answered",
    );
    if (answeredNothing) {
      await this.conversations.setNeedsAttention({
        conversationId: conversation._id,
        needsAttention: true,
        at: ingress.observedAt,
      });
    }

    const applied = await this.withPendingIngress(
      ingress.id,
      async (transaction) => {
        const cancelledOutboxCount =
          await this.repository.cancelQueuedOutboxForConversation(
            transaction,
            conversation._id,
          );

        const campaign = await this.repository.findCampaignById(
          conversation.campaignId,
          transaction,
        );
        const stopAck = await this.repository.insertOutboxIfAbsent(
          transaction,
          {
            conversationId: conversation._id,
            campaignId: conversation.campaignId,
            kind: "system",
            body: resolveStopAcknowledgementCopy(campaign?.questions),
            dedupeKey: `${FEEDBACK_STOP_ACK_DEDUPE_PREFIX}-${conversation._id}`,
          },
        );

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

        await this.repository.updateIngressProcessing(transaction, ingress.id, {
          processingStatus: "materialized",
          matchedConversationId: conversation._id,
        });

        return stopAck.row;
      },
    );

    if (applied) {
      // Appends are allowed on a closed conversation: the transcript records
      // what actually happened, and the acknowledgement is observed after the
      // closure. A crash here cannot be repaired by a replay — the fence above
      // already marked the ingress row terminal — so the WP6 delivery job
      // re-runs this same idempotent append before it sends.
      await this.outboundTranscript.record(
        applied,
        ingress.observedAt,
        correlationId,
      );
    }

    return this.complete(
      {
        outcome: "inbound_stopped",
        conversationId: conversation._id,
        ...(applied ? { stopAckOutboxId: applied.id } : {}),
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
      await this.withPendingIngress(ingress.id, async (transaction) => {
        await this.repository.updateOutboxDelivery(transaction, correlated.id, {
          deliveryStatus: coalesceDeliveryStatus(
            correlated.deliveryStatus,
            "sent",
          ),
          providerMessageId: ingress.providerMessageId,
          sentAt: correlated.sentAt ?? ingress.observedAt,
          ...(correlated.status === "pending" ||
          correlated.status === "sending" ||
          correlated.status === "sent"
            ? { status: "sent" as const }
            : {}),
        });
        await this.repository.updateIngressProcessing(transaction, ingress.id, {
          processingStatus: "materialized",
          matchedConversationId: correlated.conversationId,
        });
      });

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

    const takeover = await this.conversations.takeOver({
      conversationId: conversation._id,
      source: "external_outbound",
      at: ingress.observedAt,
    });

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

    await this.withPendingIngress(ingress.id, async (transaction) => {
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
        },
      });
      await this.repository.updateIngressProcessing(transaction, ingress.id, {
        processingStatus: "materialized",
        matchedConversationId: conversation._id,
      });
    });

    return this.complete(
      { outcome: "outbound_external", conversationId: conversation._id },
      correlationId,
    );
  }

  /**
   * The provider message id is authoritative once a send recorded it. Before
   * that — an ambiguous send, or a relay that crashed after the provider
   * accepted it — the fallback is the oldest unlinked row of the resolved
   * conversation with the exact same body. A provider id belonging to a
   * different conversation is not a match and is left to the takeover rule.
   */
  private async findCorrelatedOutbox(
    ingress: ProviderMessageIngressRow,
    conversation: FeedbackConversationDocument | undefined,
  ): Promise<MessageOutboxRow | undefined> {
    const byProviderMessageId =
      await this.repository.findOutboxByProviderMessageId(
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

    return this.repository.findUnlinkedOutboxByConversationAndBody(
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
    await this.conversations.setNeedsAttention({
      conversationId: conversation._id,
      needsAttention: true,
      at: ingress.observedAt,
    });

    // Say something, once. A body we cannot read used to produce pure silence:
    // the questionnaire simply stopped answering, so somebody dictating from
    // the car kept recording answers into a void and arrived in the campaign
    // list as a non-responder — while they had in fact answered everything.
    //
    // Only for `empty_body`. A full transcript is our problem, not theirs, and
    // asking them to retype something we simply have no room for would be a
    // lie about why we went quiet.
    const notice =
      reason === "empty_body"
        ? await this.sendMediaNotice(ingress, conversation, correlationId)
        : { inserted: false };

    // A full transcript is the one case where the bot genuinely cannot carry
    // on: it has nowhere to record what was just said, so the next question
    // would be asked into a thread that no longer remembers the answer. Hand it
    // to a person instead of continuing to look healthy while dropping words.
    if (reason === "transcript_capacity") {
      await this.conversations.markAwaitingHuman({
        conversationId: conversation._id,
        at: ingress.observedAt,
      });
    }

    await this.withPendingIngress(ingress.id, (transaction) =>
      this.repository.updateIngressProcessing(transaction, ingress.id, {
        processingStatus: "failed",
        matchedConversationId: conversation._id,
      }),
    );

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
    const campaign = await this.repository.findCampaignById(
      conversation.campaignId,
    );
    // The kill switch still governs: a paused campaign says nothing at all.
    if (campaign?.status !== "launched") {
      return { inserted: false };
    }

    const notice = await this.database.transaction((transaction) =>
      this.repository.insertOutboxIfAbsent(transaction, {
        conversationId: conversation._id,
        campaignId: conversation.campaignId,
        kind: "system",
        body: resolveCannotReadMediaCopy(campaign.questions),
        dedupeKey: createFeedbackMediaNoticeDedupeKey(conversation._id),
      }),
    );
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
    latestSeq: number,
    correlationId: string,
  ): Promise<string> {
    const data = feedbackExtractJobDataSchema.parse({
      schemaVersion: FEEDBACK_JOB_SCHEMA_VERSION,
      conversationId,
      correlationId,
    });
    const jobId = createFeedbackExtractJobId(conversationId, latestSeq);

    await this.queue.add(FEEDBACK_JOB_NAMES.extractV1, data, {
      jobId,
      delay: FEEDBACK_EXTRACT_QUIET_WINDOW_MS,
    });

    return jobId;
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
  ): Promise<T | undefined> {
    return this.database.transaction(async (transaction) => {
      const row = await this.repository.findIngressByIdForUpdate(
        transaction,
        ingressId,
      );
      if (!row || row.processingStatus !== "pending") {
        return undefined;
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

/**
 * Fits a body to the transcript, which is bounded, without pretending the rest
 * never existed.
 *
 * The bound is the transcript's *storage* limit, not the 4 096 characters we
 * are allowed to send. Those were once the same number and the cut happened at
 * the webhook edge, so a long message lost its tail before anything durable was
 * written and nobody was told — and the tail is where the thing somebody worked
 * up to saying actually lives. At 64 000 characters this now fires only for a
 * genuinely absurd payload, and still says so.
 */
function fitToTranscript(text: string): {
  readonly text: string;
  readonly truncated: boolean;
} {
  if (text.length <= FEEDBACK_CONVERSATION_MESSAGE_MAX_STORED_TEXT_LENGTH) {
    return { text, truncated: false };
  }
  return {
    text: text.slice(0, FEEDBACK_CONVERSATION_MESSAGE_MAX_STORED_TEXT_LENGTH),
    truncated: true,
  };
}

/**
 * The campaign's launch copy snapshot owns the acknowledgement wording, so a
 * later copy edit never rewrites a live questionnaire. The versioned constant
 * is the fallback when the snapshot is missing or malformed.
 */
function resolveStopAcknowledgementCopy(
  questions: Record<string, unknown> | undefined,
): string {
  return resolveCampaignCopy(questions, "stop_ack");
}

/** A campaign launched before this copy existed falls back to the constant. */
function resolveCannotReadMediaCopy(
  questions: Record<string, unknown> | undefined,
): string {
  return resolveCampaignCopy(questions, "cannot_read_media");
}

function resolveCampaignCopy(
  questions: Record<string, unknown> | undefined,
  key: "stop_ack" | "cannot_read_media",
): string {
  const copy = (questions as { copy?: Record<string, unknown> } | undefined)
    ?.copy;
  const snapshot = typeof copy?.[key] === "string" ? copy[key] : "";
  const resolved =
    snapshot.trim().length > 0
      ? snapshot.trim()
      : POST_EVENT_FEEDBACK_QUESTION_SET_V1.copy[key];

  return resolved.slice(0, FEEDBACK_CONVERSATION_MESSAGE_MAX_TEXT_LENGTH);
}
