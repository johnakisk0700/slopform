import { Injectable } from "@nestjs/common";
import type {
  AppTransaction,
  MessageOutboxRow,
  ProviderMessageIngressRow,
} from "@slopform/database";
import { AuditRepository } from "../../../infrastructure/audit/audit.repository.js";
import { DatabaseService } from "../../../infrastructure/database/database.service.js";
import { FeedbackCampaignRepository } from "../campaign/campaign.repository.js";
import { FeedbackIngressRepository } from "./ingress.repository.js";
import { FeedbackOutboxRepository } from "../outbox/outbox.repository.js";
import { FeedbackOutboundIntentService } from "../outbox/outbound-intent.service.js";
import {
  FeedbackConversationCapacityError,
  FeedbackConversationRepository,
} from "../post-event-feedback-conversation.repository.js";
import {
  FEEDBACK_CONVERSATION_MESSAGE_MAX_TEXT_LENGTH,
  deriveFeedbackStopAckOutboxId,
  resolveFeedbackConversationWork,
  type FeedbackConversationDocument,
  type FeedbackConversationWork,
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
import {
  FeedbackLogger,
  FeedbackOperationLog,
} from "../feedback-operation-log.js";
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
 * fact, resolves the conversation through the open-phone unique index (D9),
 * keeps unmatched shared-session traffic metadata-only (D10), applies STOP
 * deterministically before any AI (D14) and correlates observed outbound
 * messages to the outbox, treating an uncorrelated one as external channel
 * activity (D17).
 *
 * Every side effect of one ingress row commits in a single transaction. Queue
 * publication and campaign-summary notifications happen after that commit.
 * The session routing lock still serializes FIFO drain across rows; it is not
 * a global FIFO.
 */
@Injectable()
export class PostEventFeedbackMaterializer {
  private readonly logger = new FeedbackLogger(
    PostEventFeedbackMaterializer.name,
  );

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
    private readonly outboundIntent: FeedbackOutboundIntentService,
    private readonly summaries: PostEventFeedbackCampaignSummaryService,
    private readonly wakeups: FeedbackConversationWakeupService,
  ) {}

  async materialize(
    input: MaterializeFeedbackIngressInput,
  ): Promise<MaterializeFeedbackIngressResult> {
    const operation = new FeedbackOperationLog(this.logger, {
      operation: "materialize",
      correlationId: input.correlationId,
      ingressId: input.ingressId,
    });
    try {
      const result = await this.materializeOnce(input, operation);
      operation.complete(result.outcome);
      return result;
    } catch (error) {
      operation.failed(error);
      throw error;
    }
  }

  private async materializeOnce(
    input: MaterializeFeedbackIngressInput,
    operation: FeedbackOperationLog,
  ): Promise<MaterializeFeedbackIngressResult> {
    operation.stage("ingress_load");
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

    operation.stage("conversation_match");
    const conversation = ingress.phoneE164
      ? await this.conversations.findOpenByPhone(ingress.phoneE164)
      : undefined;

    if (ingress.direction === "outbound") {
      // An outbound observation is worth correlating even without an open
      // conversation: a STOP acknowledgement is sent to a conversation that is
      // already closed, and recording it as unrelated traffic would both lose
      // its delivery state and inflate the unmatched counter.
      operation.stage("outbound");
      return this.materializeOutbound(
        ingress,
        conversation,
        input.correlationId,
        operation,
      );
    }

    if (conversation) {
      operation.enrich({
        conversationId: conversation._id,
        campaignId: conversation.campaignId,
      });
      operation.stage("inbound");
      return this.materializeInbound(
        ingress,
        conversation,
        input.correlationId,
        operation,
      );
    }

    // Before calling it unmatched: the questionnaire may simply have ended.
    // Our own closing copy invites another message, and people take it up.
    const closed = ingress.phoneE164
      ? await this.conversations.findLatestClosedByPhone(ingress.phoneE164)
      : undefined;

    if (closed) {
      operation.enrich({
        conversationId: closed._id,
        campaignId: closed.campaignId,
      });
      operation.stage("post_closure");
      return this.materializePostClosure(
        ingress,
        closed,
        input.correlationId,
        operation,
      );
    }
    operation.stage("unmatched");
    return this.ignoreUnmatched(ingress, input.correlationId, operation);
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
    operation: FeedbackOperationLog,
  ): Promise<MaterializeFeedbackIngressResult> {
    const text = ingress.text?.trim() ?? "";

    if (text.length > 0 && matchesPostEventFeedbackStopCommand(text)) {
      return this.applyStop(ingress, conversation, correlationId, operation);
    }

    const retainsText = conversation.lifecycle.reason !== "stopped";
    operation.stage("persist");
    await this.withPendingIngress(
      ingress.id,
      async (transaction) => {
        let writtenMessageId: string | null = null;
        if (retainsText && text.length > 0) {
          try {
            const appended = await this.conversations.appendMessage(
              transaction,
              {
                conversationId: conversation._id,
                actor: "participant",
                text: fitToTranscript(text).text,
                at: ingress.observedAt,
                providerMessageId: ingress.providerMessageId,
                ingressId: ingress.id,
              },
            );
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

        // Anchored on the turn that was just written, because the whole reason
        // this path raises at all is that nobody is watching a closed
        // conversation and this is the message they need to read. A STOP-closed
        // thread keeps no text, so there is nothing to link to.
        await this.conversations.raiseAttention(transaction, {
          conversationId: conversation._id,
          kind: "post_closure_message",
          messageId: writtenMessageId,
          at: ingress.observedAt,
        });
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
      },
      conversation._id,
    );

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
    operation: FeedbackOperationLog,
  ): Promise<MaterializeFeedbackIngressResult> {
    const hasBody = (ingress.text?.trim().length ?? 0) > 0;

    operation.stage("persist");
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
    operation: FeedbackOperationLog,
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
        operation,
      );
    }

    const stopRequested = matchesPostEventFeedbackStopCommand(text);
    if (stopRequested) {
      return this.applyStop(ingress, conversation, correlationId, operation);
    }

    const rendered = fitToTranscript(text);
    let materialized: { work: FeedbackConversationWork } | undefined;
    try {
      operation.stage("persist");
      materialized = await this.withPendingIngress(
        ingress.id,
        async (transaction) => {
          const appended = await this.conversations.appendMessage(transaction, {
            conversationId: conversation._id,
            actor: "participant",
            text: rendered.text,
            at: ingress.observedAt,
            providerMessageId: ingress.providerMessageId,
            ingressId: ingress.id,
          });

          if (rendered.truncated) {
            await this.conversations.raiseAttention(transaction, {
              conversationId: conversation._id,
              kind: "transcript_mismatch",
              messageId: appended.message.id,
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
          // versions are readable. Which one the participant meant is a judgement
          // for a person. Same reason kind as a truncation: both say the
          // transcript is not what arrived.
          if (isFeedbackEditedProviderMessageId(ingress.providerMessageId)) {
            await this.conversations.raiseAttention(transaction, {
              conversationId: conversation._id,
              kind: "transcript_mismatch",
              messageId: appended.message.id,
              at: ingress.observedAt,
            });
            this.logger.warn({
              event: "feedback.materialize.edited_redelivery",
              correlationId,
              ingressId: ingress.id,
              conversationId: conversation._id,
            });
          }

          const due = await this.conversations.markWorkDue(transaction, {
            conversationId: conversation._id,
            nextActionAt: new Date(
              ingress.observedAt.getTime() + FEEDBACK_EXTRACT_QUIET_WINDOW_MS,
            ),
            at: ingress.observedAt,
          });
          const currentHandoffOutboxId = currentAwaitingHumanCommitmentOutboxId(
            appended.conversation,
          );
          const terminalOutboxId =
            appended.conversation.lifecycle.state === "closed"
              ? (appended.conversation.lifecycle.terminalOutboxId ?? null)
              : null;
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
          return { work: due.work };
        },
        conversation._id,
      );
    } catch (error) {
      if (!(error instanceof FeedbackConversationCapacityError)) {
        throw error;
      }
      return this.flagUnmaterializedInbound(
        ingress,
        conversation,
        correlationId,
        "transcript_capacity",
        operation,
      );
    }

    if (!materialized) {
      return this.complete(
        { outcome: "already_processed", conversationId: conversation._id },
        correlationId,
      );
    }

    operation.stage("wakeup");
    const extractJobId = await this.publishWakeup(
      conversation._id,
      materialized.work,
      correlationId,
      ingress.observedAt,
    );

    return this.complete(
      {
        outcome: "inbound_materialized",
        conversationId: conversation._id,
        ...(extractJobId ? { extractJobId } : {}),
      },
      correlationId,
    );
  }

  /**
   * D14: STOP is deterministic in both control modes. Consent, close, ack,
   * outbox cancel and ingress settlement share one transaction. Campaign SHARE
   * precedes conversation-row writes so resume cannot deadlock.
   */
  private async applyStop(
    ingress: ProviderMessageIngressRow,
    conversation: FeedbackConversationDocument,
    correlationId: string,
    operation: FeedbackOperationLog,
  ): Promise<MaterializeFeedbackIngressResult> {
    const text = ingress.text?.trim() ?? "";
    operation.stage("persist_stop");
    const applied = await this.withPendingIngress(
      ingress.id,
      async (transaction) => {
        const campaign = await this.campaigns.findCampaignByIdForShare(
          transaction,
          conversation.campaignId,
        );
        const stopMessageId = await this.appendStopTurnIfCapacityAllows(
          transaction,
          ingress,
          conversation,
          text,
          correlationId,
        );

        const stopAck = await this.outboundIntent.enqueue(transaction, {
          dispatch: {
            schemaVersion: 1,
            purpose: "stop_ack",
            sourceIngressId: ingress.id,
          },
          message: {
            id: deriveFeedbackStopAckOutboxId(conversation._id),
            conversationId: conversation._id,
            campaignId: conversation.campaignId,
            body: resolveCampaignCopy(
              campaign?.questions,
              campaign?.questionSetVersion,
            ).stop_ack.slice(0, FEEDBACK_CONVERSATION_MESSAGE_MAX_TEXT_LENGTH),
            dedupeKey: createFeedbackStopAckDedupeKey(conversation._id),
          },
          history: { deferred: "stop_ack_after_mutations" },
        });
        const closed = await this.conversations.close(transaction, {
          conversationId: conversation._id,
          reason: "stopped",
          at: ingress.observedAt,
          terminalOutboxId: stopAck.row.id,
        });

        const answeredNothing = conversation.goals.every(
          (goal) => goal.status !== "answered",
        );
        if (answeredNothing) {
          await this.conversations.raiseAttention(transaction, {
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
        await this.outboundIntent.recordHistory(transaction, {
          outbox: stopAck,
          conversation,
          decision: {
            origin: "stop_ack",
            sourceIngressId: ingress.id,
          },
          correlationId,
        });
        const recorded = await this.outboundTranscript.record(
          transaction,
          stopAck.row,
          ingress.observedAt,
          correlationId,
        );
        if (recorded.outcome === "cancelled") {
          this.logger.warn({
            event: "feedback.materialize.stop_ack_transcript_cancelled",
            correlationId,
            ingressId: ingress.id,
            conversationId: conversation._id,
            reason: recorded.reason,
          });
        }

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
      operation.stage("summary");
      await this.summaries.notifyIfLastConversationClosed(
        conversation.campaignId,
        correlationId,
        applied.closed,
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

  /**
   * Optional STOP append. Capacity is not a consent failure: keep raw ingress,
   * retain `transcript_full`, and still close/opt-out. Other errors abort.
   */
  private async appendStopTurnIfCapacityAllows(
    transaction: AppTransaction,
    ingress: ProviderMessageIngressRow,
    conversation: FeedbackConversationDocument,
    text: string,
    correlationId: string,
  ): Promise<string | null> {
    if (conversation.lifecycle.state !== "open" || text.length === 0) {
      return null;
    }

    const rendered = fitToTranscript(text);
    try {
      const appended = await this.conversations.appendMessage(transaction, {
        conversationId: conversation._id,
        actor: "participant",
        text: rendered.text,
        at: ingress.observedAt,
        providerMessageId: ingress.providerMessageId,
        ingressId: ingress.id,
      });
      if (rendered.truncated) {
        await this.conversations.raiseAttention(transaction, {
          conversationId: conversation._id,
          kind: "transcript_mismatch",
          messageId: appended.message.id,
          at: ingress.observedAt,
        });
      }
      if (isFeedbackEditedProviderMessageId(ingress.providerMessageId)) {
        await this.conversations.raiseAttention(transaction, {
          conversationId: conversation._id,
          kind: "transcript_mismatch",
          messageId: appended.message.id,
          at: ingress.observedAt,
        });
      }
      return appended.message.id;
    } catch (error) {
      if (!(error instanceof FeedbackConversationCapacityError)) {
        throw error;
      }
      await this.conversations.raiseAttention(transaction, {
        conversationId: conversation._id,
        kind: "transcript_full",
        messageId: null,
        at: ingress.observedAt,
      });
      this.logger.warn({
        event: "feedback.materialize.transcript_capacity",
        correlationId,
        ingressId: ingress.id,
        conversationId: conversation._id,
      });
      return null;
    }
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
    operation: FeedbackOperationLog,
  ): Promise<MaterializeFeedbackIngressResult> {
    const correlated = await this.findCorrelatedOutbox(ingress, conversation);

    if (correlated) {
      operation.enrich({
        conversationId: correlated.conversationId,
        outboxId: correlated.id,
      });
      operation.stage("persist");
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
      operation.stage("unmatched");
      return this.ignoreUnmatched(ingress, correlationId, operation);
    }

    operation.enrich({ conversationId: conversation._id });
    operation.stage("persist");
    await this.withPendingIngress(
      ingress.id,
      async (transaction) => {
        const takeover = await this.conversations.takeOver(transaction, {
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
            await this.conversations.appendMessage(transaction, {
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
    operation: FeedbackOperationLog,
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
    operation.stage("persist");
    if (reason === "transcript_capacity") {
      // Commit the bot brake and failed ingress under the dispatcher's mutex.
      await this.withPendingIngress(
        ingress.id,
        async (transaction) => {
          await this.conversations.raiseAttention(transaction, attention);
          await this.conversations.markAwaitingHuman(transaction, {
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
      notice = (await this.withPendingIngress(
        ingress.id,
        async (transaction) => {
          // Campaign SHARE before the conversation-row attention write.
          // Resume takes campaign FOR UPDATE then updates conversation rows;
          // the inverse deadlocks. `sendMediaNotice` re-takes the same SHARE.
          await this.campaigns.findCampaignByIdForShare(
            transaction,
            conversation.campaignId,
          );
          await this.conversations.raiseAttention(transaction, attention);
          const sent = await this.sendMediaNotice(
            transaction,
            ingress,
            conversation,
            correlationId,
          );
          await this.ingress.updateIngressProcessing(transaction, ingress.id, {
            processingStatus: "failed",
            matchedConversationId: conversation._id,
          });
          return sent;
        },
        conversation._id,
      )) ?? { inserted: false };
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
    transaction: AppTransaction,
    ingress: ProviderMessageIngressRow,
    conversation: FeedbackConversationDocument,
    correlationId: string,
  ): Promise<{ inserted: boolean }> {
    const campaign = await this.campaigns.findCampaignByIdForShare(
      transaction,
      conversation.campaignId,
    );
    // The kill switch still governs: a paused campaign says nothing at all.
    if (campaign?.status !== "launched") {
      return { inserted: false };
    }

    const notice = await this.outboundIntent.enqueue(transaction, {
      dispatch: {
        schemaVersion: 1,
        purpose: "media_notice",
        sourceIngressId: ingress.id,
      },
      message: {
        conversationId: conversation._id,
        campaignId: conversation.campaignId,
        body: resolveCampaignCopy(
          campaign.questions,
          campaign.questionSetVersion,
        ).cannot_read_media.slice(
          0,
          FEEDBACK_CONVERSATION_MESSAGE_MAX_TEXT_LENGTH,
        ),
        dedupeKey: createFeedbackMediaNoticeDedupeKey(conversation._id),
      },
      history: {
        conversation,
        decision: {
          origin: "media_notice",
          sourceIngressId: ingress.id,
        },
        correlationId,
      },
    });
    if (notice.inserted) {
      await this.outboundTranscript.record(
        transaction,
        notice.row,
        ingress.observedAt,
        correlationId,
      );
    }
    return { inserted: notice.inserted };
  }

  /**
   * Publishes the quiet-window wake-up after the ingress transaction committed
   * the due revision. Redis is disposable; maintenance rediscovers the same
   * work column.
   */
  private async publishWakeup(
    conversationId: string,
    work: FeedbackConversationWork,
    correlationId: string,
    now: Date,
  ): Promise<string | undefined> {
    return this.wakeups.ensureQueued({
      conversationId,
      work: resolveFeedbackConversationWork(work),
      correlationId,
      now,
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
