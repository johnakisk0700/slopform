import { Injectable } from "@nestjs/common";
import type { ProviderMessageIngressRow } from "@slopform/database";

import { FeedbackIngressRepository } from "./ingress.repository.js";
import { FeedbackConversationRepository } from "../post-event-feedback-conversation.repository.js";
import { PostEventFeedbackMetrics } from "../metrics.service.js";
import {
  FeedbackLogger,
  FeedbackOperationLog,
} from "../feedback-operation-log.js";
import { FeedbackClosedConversationIngressService } from "./closed-conversation-ingress.service.js";
import { FeedbackInboundMessageService } from "./inbound-message.service.js";
import { FeedbackObservedOutboundService } from "./observed-outbound.service.js";
import { PendingFeedbackIngressService } from "./pending-ingress.service.js";
import type {
  MaterializeFeedbackIngressInput,
  MaterializeFeedbackIngressResult,
} from "./materialize.types.js";

export class PostEventFeedbackIngressNotFoundError extends Error {
  constructor(ingressId: string) {
    super(`Provider message ingress ${ingressId} was not found`);
    this.name = PostEventFeedbackIngressNotFoundError.name;
  }
}

/**
 * Routes one pending ingress row: outbound correlation first, then open
 * inbound, latest closed inbound, or unmatched. Records the materialize
 * metric once on the returned outcome.
 */
@Injectable()
export class PostEventFeedbackMaterializer {
  private readonly logger = new FeedbackLogger(
    PostEventFeedbackMaterializer.name,
  );

  constructor(
    private readonly ingress: FeedbackIngressRepository,
    private readonly conversations: FeedbackConversationRepository,
    private readonly metrics: PostEventFeedbackMetrics,
    private readonly pending: PendingFeedbackIngressService,
    private readonly inbound: FeedbackInboundMessageService,
    private readonly closedIngress: FeedbackClosedConversationIngressService,
    private readonly outbound: FeedbackObservedOutboundService,
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
      this.metrics.recordMaterializeOutcome(
        result.outcome,
        input.correlationId,
      );
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
      return { outcome: "already_processed" };
    }

    operation.stage("conversation_match");
    const conversation = ingress.phoneE164
      ? await this.conversations.findOpenByPhone(ingress.phoneE164)
      : undefined;

    if (ingress.direction === "outbound") {
      // Correlate even without an open conversation: a STOP ack is sent to a
      // thread that is already closed.
      operation.stage("outbound");
      const outbound = await this.outbound.materialize(
        ingress,
        conversation,
        input.correlationId,
        operation,
      );
      if (!outbound) {
        operation.stage("unmatched");
        return this.ignoreUnmatched(ingress, input.correlationId, operation);
      }
      return outbound;
    }

    if (conversation) {
      operation.enrich({
        conversationId: conversation._id,
        campaignId: conversation.campaignId,
      });
      operation.stage("inbound");
      return this.inbound.materialize(
        ingress,
        conversation,
        input.correlationId,
        operation,
      );
    }

    // The questionnaire may already have ended; look at the latest closed
    // thread before treating the row as unmatched shared-session traffic.
    const closed = ingress.phoneE164
      ? await this.conversations.findLatestClosedByPhone(ingress.phoneE164)
      : undefined;

    if (closed) {
      operation.enrich({
        conversationId: closed._id,
        campaignId: closed.campaignId,
      });
      operation.stage("post_closure");
      return this.closedIngress.materialize(
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
   * Shared-session traffic with no known conversation. The body stays on the
   * durable row as ignored_unmatched (not erased). Extraction never sees it.
   */
  private async ignoreUnmatched(
    ingress: ProviderMessageIngressRow,
    correlationId: string,
    operation: FeedbackOperationLog,
  ): Promise<MaterializeFeedbackIngressResult> {
    const hasBody = (ingress.text?.trim().length ?? 0) > 0;

    operation.stage("persist");
    await this.pending.applyPending(ingress.id, (transaction) =>
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

    return { outcome: "ignored_unmatched" };
  }
}
