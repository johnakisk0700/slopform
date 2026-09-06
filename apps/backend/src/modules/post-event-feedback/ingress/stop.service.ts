import { Injectable } from "@nestjs/common";
import type {
  AppTransaction,
  ProviderMessageIngressRow,
} from "@slopform/database";

import { AuditRepository } from "../../../infrastructure/audit/audit.repository.js";
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
  type FeedbackConversationDocument,
} from "../post-event-feedback-conversation.document.js";
import { ParticipantsRepository } from "../../participants/participants.repository.js";
import { FeedbackOutboundTranscriptService } from "../outbox/outbound-transcript.service.js";
import {
  createFeedbackStopAckDedupeKey,
  fitToTranscript,
  resolveCampaignCopy,
} from "../question-set.js";
import { isFeedbackEditedProviderMessageId } from "../jobs.schemas.js";
import { PostEventFeedbackCampaignSummaryService } from "../summary/summary.service.js";
import {
  FeedbackLogger,
  type FeedbackOperationLog,
} from "../feedback-operation-log.js";
import { PendingFeedbackIngressService } from "./pending-ingress.service.js";
import type { MaterializeFeedbackIngressResult } from "./materialize.types.js";
import type { FeedbackStopApplied } from "./stop.types.js";

/**
 * Deterministic STOP: campaign SHARE, optional append, exact ack, close,
 * opt-out and ingress terminal in one pending-ingress transaction. Capacity
 * does not prevent close. Summary notify runs after commit.
 */
@Injectable()
export class FeedbackStopService {
  private readonly logger = new FeedbackLogger(FeedbackStopService.name);

  constructor(
    private readonly campaigns: FeedbackCampaignRepository,
    private readonly ingress: FeedbackIngressRepository,
    private readonly outbox: FeedbackOutboxRepository,
    private readonly conversations: FeedbackConversationRepository,
    private readonly participants: ParticipantsRepository,
    private readonly audit: AuditRepository,
    private readonly outboundTranscript: FeedbackOutboundTranscriptService,
    private readonly outboundIntent: FeedbackOutboundIntentService,
    private readonly summaries: PostEventFeedbackCampaignSummaryService,
    private readonly pending: PendingFeedbackIngressService,
  ) {}

  async apply(
    ingress: ProviderMessageIngressRow,
    conversation: FeedbackConversationDocument,
    correlationId: string,
    operation: FeedbackOperationLog,
  ): Promise<MaterializeFeedbackIngressResult> {
    const text = ingress.text?.trim() ?? "";
    operation.stage("persist_stop");
    const applied: FeedbackStopApplied | undefined =
      await this.pending.applyPending(
        ingress.id,
        async (transaction) => {
          // Campaign SHARE before conversation-row writes so resume cannot deadlock.
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
              ).stop_ack.slice(
                0,
                FEEDBACK_CONVERSATION_MESSAGE_MAX_TEXT_LENGTH,
              ),
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

    // Replay/race still reports inbound_stopped; only the ack id and summary are omitted.
    if (applied) {
      operation.stage("summary");
      await this.summaries.notifyIfLastConversationClosed(
        conversation.campaignId,
        correlationId,
        applied.closed,
      );
    }

    return {
      outcome: "inbound_stopped",
      conversationId: conversation._id,
      ...(applied ? { stopAckOutboxId: applied.stopAck.id } : {}),
    };
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
}
