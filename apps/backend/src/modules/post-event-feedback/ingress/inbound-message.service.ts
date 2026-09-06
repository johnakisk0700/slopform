import { Injectable } from "@nestjs/common";
import type {
  AppTransaction,
  ProviderMessageIngressRow,
} from "@slopform/database";

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
  resolveFeedbackConversationWork,
  type FeedbackConversationDocument,
  type FeedbackConversationWork,
} from "../post-event-feedback-conversation.document.js";
import { FeedbackOutboundTranscriptService } from "../outbox/outbound-transcript.service.js";
import { currentAwaitingHumanCommitmentOutboxId } from "../outbox/current-commitment.js";
import {
  createFeedbackMediaNoticeDedupeKey,
  fitToTranscript,
  resolveCampaignCopy,
} from "../question-set.js";
import { matchesPostEventFeedbackStopCommand } from "../matching/stop-command.js";
import {
  FEEDBACK_EXTRACT_QUIET_WINDOW_MS,
  isFeedbackEditedProviderMessageId,
} from "../jobs.schemas.js";
import {
  FeedbackLogger,
  type FeedbackOperationLog,
} from "../feedback-operation-log.js";
import { FeedbackConversationWakeupService } from "../reconciliation/wakeup.service.js";
import { PendingFeedbackIngressService } from "./pending-ingress.service.js";
import { FeedbackStopService } from "./stop.service.js";
import type { FeedbackUnmaterializedInboundReason } from "./inbound-message.types.js";
import type { MaterializeFeedbackIngressResult } from "./materialize.types.js";

/**
 * Ordinary inbound: STOP, empty media, capacity, or append + quiet-window work.
 * Wake-up publishes after the persist transaction commits.
 */
@Injectable()
export class FeedbackInboundMessageService {
  private readonly logger = new FeedbackLogger(
    FeedbackInboundMessageService.name,
  );

  constructor(
    private readonly campaigns: FeedbackCampaignRepository,
    private readonly ingress: FeedbackIngressRepository,
    private readonly outbox: FeedbackOutboxRepository,
    private readonly conversations: FeedbackConversationRepository,
    private readonly outboundTranscript: FeedbackOutboundTranscriptService,
    private readonly outboundIntent: FeedbackOutboundIntentService,
    private readonly wakeups: FeedbackConversationWakeupService,
    private readonly pending: PendingFeedbackIngressService,
    private readonly stop: FeedbackStopService,
  ) {}

  async materialize(
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

    if (matchesPostEventFeedbackStopCommand(text)) {
      return this.stop.apply(ingress, conversation, correlationId, operation);
    }

    return this.persistOrdinaryInbound(
      ingress,
      conversation,
      text,
      correlationId,
      operation,
    );
  }

  private async persistOrdinaryInbound(
    ingress: ProviderMessageIngressRow,
    conversation: FeedbackConversationDocument,
    text: string,
    correlationId: string,
    operation: FeedbackOperationLog,
  ): Promise<MaterializeFeedbackIngressResult> {
    const rendered = fitToTranscript(text);
    let materialized: { work: FeedbackConversationWork } | undefined;
    try {
      operation.stage("persist");
      materialized = await this.pending.applyPending(
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

          // An edited redelivery is its own turn so both versions stay readable.
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
      // Capacity rolls this transaction back; the brake is a later, separate persist.
      return this.flagUnmaterializedInbound(
        ingress,
        conversation,
        correlationId,
        "transcript_capacity",
        operation,
      );
    }

    // A lost race on the ingress fence is the only route that reports already_processed.
    if (!materialized) {
      return {
        outcome: "already_processed",
        conversationId: conversation._id,
      };
    }

    operation.stage("wakeup");
    const extractJobId = await this.publishWakeup(
      conversation._id,
      materialized.work,
      correlationId,
      ingress.observedAt,
    );

    return {
      outcome: "inbound_materialized",
      conversationId: conversation._id,
      ...(extractJobId ? { extractJobId } : {}),
    };
  }

  private async flagUnmaterializedInbound(
    ingress: ProviderMessageIngressRow,
    conversation: FeedbackConversationDocument,
    correlationId: string,
    reason: FeedbackUnmaterializedInboundReason,
    operation: FeedbackOperationLog,
  ): Promise<MaterializeFeedbackIngressResult> {
    // Empty body is work an operator can finish; a full transcript is not, so
    // that path also hands the thread to a person. Nothing was appended, so
    // there is no transcript line to anchor.
    const attention = {
      conversationId: conversation._id,
      kind: reason === "empty_body" ? "unreadable_message" : "transcript_full",
      messageId: null,
      at: ingress.observedAt,
    } as const;

    let notice = { inserted: false };
    operation.stage("persist");
    if (reason === "transcript_capacity") {
      await this.pending.applyPending(
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
      notice = (await this.pending.applyPending(
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

    return {
      outcome: "inbound_not_materialized",
      conversationId: conversation._id,
    };
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
   * work column. Queue errors propagate; this does not retry or swallow.
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
}
