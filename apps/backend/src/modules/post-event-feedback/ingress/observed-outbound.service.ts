import { Injectable } from "@nestjs/common";
import type {
  MessageOutboxRow,
  ProviderMessageIngressRow,
} from "@slopform/database";

import { AuditRepository } from "../../../infrastructure/audit/audit.repository.js";
import { FeedbackIngressRepository } from "./ingress.repository.js";
import { FeedbackOutboxRepository } from "../outbox/outbox.repository.js";
import {
  FeedbackConversationCapacityError,
  FeedbackConversationRepository,
} from "../post-event-feedback-conversation.repository.js";
import type { FeedbackConversationDocument } from "../post-event-feedback-conversation.document.js";
import { coalesceDeliveryStatus } from "../outbox/delivery-status.js";
import {
  FeedbackLogger,
  type FeedbackOperationLog,
} from "../feedback-operation-log.js";
import { PendingFeedbackIngressService } from "./pending-ingress.service.js";
import type { MaterializeFeedbackIngressResult } from "./materialize.types.js";

/**
 * Observed outbound: correlate by provider id or same body, else staff
 * takeover. Returns undefined only when uncorrelated and no open conversation.
 */
@Injectable()
export class FeedbackObservedOutboundService {
  private readonly logger = new FeedbackLogger(
    FeedbackObservedOutboundService.name,
  );

  constructor(
    private readonly ingress: FeedbackIngressRepository,
    private readonly outbox: FeedbackOutboxRepository,
    private readonly conversations: FeedbackConversationRepository,
    private readonly audit: AuditRepository,
    private readonly pending: PendingFeedbackIngressService,
  ) {}

  async materialize(
    ingress: ProviderMessageIngressRow,
    conversation: FeedbackConversationDocument | undefined,
    correlationId: string,
    operation: FeedbackOperationLog,
  ): Promise<MaterializeFeedbackIngressResult | undefined> {
    const correlated = await this.findCorrelatedOutbox(ingress, conversation);

    if (correlated) {
      return this.persistCorrelatedDelivery(
        ingress,
        correlated,
        correlationId,
        operation,
      );
    }

    if (!conversation) {
      return undefined;
    }

    return this.persistExternalTakeover(
      ingress,
      conversation,
      correlationId,
      operation,
    );
  }

  /**
   * The provider message id is authoritative once a send recorded it. Before
   * that — an ambiguous send, or a legacy delivery that crashed after the
   * provider accepted it — the fallback is the oldest unlinked row of the
   * resolved conversation with the exact same body. A provider id belonging to
   * a different conversation is not a match and is left to the takeover rule.
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

  private async persistCorrelatedDelivery(
    ingress: ProviderMessageIngressRow,
    correlated: MessageOutboxRow,
    correlationId: string,
    operation: FeedbackOperationLog,
  ): Promise<MaterializeFeedbackIngressResult> {
    operation.enrich({
      conversationId: correlated.conversationId,
      outboxId: correlated.id,
    });
    operation.stage("persist");
    await this.pending.applyPending(
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

    return {
      outcome: "outbound_correlated",
      conversationId: correlated.conversationId,
      correlatedOutboxId: correlated.id,
    };
  }

  private async persistExternalTakeover(
    ingress: ProviderMessageIngressRow,
    conversation: FeedbackConversationDocument,
    correlationId: string,
    operation: FeedbackOperationLog,
  ): Promise<MaterializeFeedbackIngressResult> {
    operation.enrich({ conversationId: conversation._id });
    operation.stage("persist");
    await this.pending.applyPending(
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

    return {
      outcome: "outbound_external",
      conversationId: conversation._id,
    };
  }
}
