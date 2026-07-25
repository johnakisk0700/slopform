import { InjectQueue } from "@nestjs/bullmq";
import { Injectable, Logger } from "@nestjs/common";
import type {
  AppTransaction,
  MessageOutboxDeliveryStatus,
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
import type { FeedbackConversationDocument } from "../conversations/feedback-conversation.schemas.js";
import { ParticipantsRepository } from "../participants/participants.repository.js";
import {
  PostEventFeedbackMetrics,
  type FeedbackMaterializeOutcome,
} from "./post-event-feedback-metrics.service.js";
import { POST_EVENT_FEEDBACK_QUESTION_SET_V1 } from "./post-event-feedback-question-set.js";
import { matchesPostEventFeedbackStopCommand } from "./post-event-feedback-stop-matcher.js";
import { PostEventFeedbackRepository } from "./post-event-feedback.repository.js";
import {
  createFeedbackExtractJobId,
  FEEDBACK_JOB_NAMES,
  FEEDBACK_JOB_SCHEMA_VERSION,
  feedbackExtractJobDataSchema,
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

const DELIVERY_STATUS_RANK: Record<MessageOutboxDeliveryStatus, number> = {
  error: 0,
  pending: 1,
  sent: 2,
  delivered: 3,
  read: 4,
  played: 5,
};

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

    return conversation
      ? this.materializeInbound(ingress, conversation, input.correlationId)
      : this.ignoreUnmatched(ingress, input.correlationId);
  }

  /**
   * D10: the shared WhatsApp session also carries WordPress-era and unrelated
   * traffic. Those rows keep provider metadata only, drop the body and are
   * never seen by extraction.
   */
  private async ignoreUnmatched(
    ingress: ProviderMessageIngressRow,
    correlationId: string,
  ): Promise<MaterializeFeedbackIngressResult> {
    await this.withPendingIngress(ingress.id, (transaction) =>
      this.repository.updateIngressProcessing(transaction, ingress.id, {
        processingStatus: "ignored_unmatched",
        matchedConversationId: null,
        text: null,
      }),
    );

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
    let latestSeq: number;

    try {
      const appended = await this.conversations.appendMessage({
        conversationId: conversation._id,
        actor: "participant",
        text,
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

    await this.withPendingIngress(ingress.id, (transaction) =>
      this.repository.updateIngressProcessing(transaction, ingress.id, {
        processingStatus: "materialized",
        matchedConversationId: conversation._id,
      }),
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
  ): Promise<MaterializeFeedbackIngressResult> {
    await this.conversations.close({
      conversationId: conversation._id,
      reason: "stopped",
      at: ingress.observedAt,
    });

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

        return stopAck.row.id;
      },
    );

    return this.complete(
      {
        outcome: "inbound_stopped",
        conversationId: conversation._id,
        ...(applied ? { stopAckOutboxId: applied } : {}),
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
          deliveryStatus: nextDeliveryStatus(correlated.deliveryStatus),
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
    });

    return this.complete(
      {
        outcome: "inbound_not_materialized",
        conversationId: conversation._id,
      },
      correlationId,
    );
  }

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

    await this.queue.add(FEEDBACK_JOB_NAMES.extractV1, data, { jobId });

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

function nextDeliveryStatus(
  current: string | null,
): MessageOutboxDeliveryStatus {
  const known = current as MessageOutboxDeliveryStatus | null;
  return known && DELIVERY_STATUS_RANK[known] > DELIVERY_STATUS_RANK.sent
    ? known
    : "sent";
}

/**
 * The campaign's launch copy snapshot owns the acknowledgement wording, so a
 * later copy edit never rewrites a live questionnaire. The versioned constant
 * is the fallback when the snapshot is missing or malformed.
 */
function resolveStopAcknowledgementCopy(
  questions: Record<string, unknown> | undefined,
): string {
  const copy = (questions as { copy?: Record<string, unknown> } | undefined)
    ?.copy;
  const snapshot =
    typeof copy?.["stop_ack"] === "string" ? copy["stop_ack"] : "";
  const resolved =
    snapshot.trim().length > 0
      ? snapshot.trim()
      : POST_EVENT_FEEDBACK_QUESTION_SET_V1.copy.stop_ack;

  return resolved.slice(0, 4_096);
}
