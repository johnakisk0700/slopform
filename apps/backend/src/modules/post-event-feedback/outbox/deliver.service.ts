import { Inject, Injectable, Logger } from "@nestjs/common";

import type {
  MessageOutboxDeliveryStatus,
  MessageOutboxRow,
} from "@join-the-six/database";

import { DatabaseService } from "../../../infrastructure/database/database.service.js";
import { FeedbackCampaignRepository } from "../campaign/campaign.repository.js";
import { FeedbackOutboxRepository } from "./outbox.repository.js";
import { FeedbackConversationRepository } from "../post-event-feedback-conversation.repository.js";
import { FeedbackOutboundTranscriptService } from "./outbound-transcript.service.js";
import { FEEDBACK_TRANSPORT, type FeedbackTransport } from "./transport.js";
import {
  coalesceDeliveryStatus,
  deliveryTimestampFields,
} from "./delivery-status.js";

export class MessageOutboxNotFoundError extends Error {
  constructor(outboxId: string) {
    super(`Message outbox ${outboxId} was not found`);
    this.name = MessageOutboxNotFoundError.name;
  }
}

export type DeliverMessageOutboxResult =
  | { readonly outcome: "sent" }
  | { outcome: "failed" }
  | { outcome: "cancelled" }
  | { outcome: "held" }
  | { outcome: "already_terminal" }
  | { outcome: "reconciled" }
  | { outcome: "awaiting_observation" }
  | { outcome: "skipped_not_sending" };

/**
 * Worker-side consumer for `feedback.deliver.v1`. Reloads the outbox row and
 * conversation phone, sends through the injectable transport, and never
 * blindly retries an unknown provider outcome.
 */
@Injectable()
export class MessageOutboxDeliveryService {
  private readonly logger = new Logger(MessageOutboxDeliveryService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly campaigns: FeedbackCampaignRepository,
    private readonly outbox: FeedbackOutboxRepository,
    private readonly conversations: FeedbackConversationRepository,
    private readonly outboundTranscript: FeedbackOutboundTranscriptService,
    @Inject(FEEDBACK_TRANSPORT)
    private readonly transport: FeedbackTransport,
  ) {}

  async deliver(
    outboxId: string,
    correlationId: string,
  ): Promise<DeliverMessageOutboxResult> {
    const row = await this.outbox.findOutboxById(outboxId);
    if (!row) {
      throw new MessageOutboxNotFoundError(outboxId);
    }

    if (row.status === "cancelled") {
      return { outcome: "cancelled" };
    }
    if (row.status === "held") {
      return { outcome: "held" };
    }
    if (row.status === "sent" || row.status === "failed") {
      return { outcome: "already_terminal" };
    }
    if (row.status !== "sending") {
      return { outcome: "skipped_not_sending" };
    }

    const campaign = await this.campaigns.findCampaignById(row.campaignId);
    if (campaign?.status !== "launched") {
      await this.outbox.releaseOutboxLease(row.id, new Date());
      this.logger.log({
        event: "feedback.outbox.skipped_campaign_inactive",
        correlationId,
        outboxId: row.id,
        campaignStatus: campaign?.status ?? "missing",
      });
      return { outcome: "held" };
    }

    // A prior unknown send, or a reclaim after a lost job that already recorded
    // provider IDs, must reconcile — never call sendText again.
    if (
      row.providerLogId ||
      row.providerMessageId ||
      row.deliveryStatus !== null
    ) {
      return this.reconcile(row, correlationId);
    }

    const conversation = await this.conversations.findById(row.conversationId);
    if (!conversation) {
      await this.markFailed(row.id, null, correlationId);
      this.logger.error({
        event: "feedback.outbox.conversation_missing",
        correlationId,
        outboxId: row.id,
      });
      return { outcome: "failed" };
    }

    // The forward repair for a producer that crashed between its PostgreSQL
    // commit and the MongoDB append (the STOP acknowledgement cannot replay:
    // its ingress row is already terminal). Normally a no-op, because the
    // append is idempotent by `outboxId`. It runs before `sendText` so nothing
    // reaches a participant that the transcript could not record.
    const recorded = await this.outboundTranscript.record(
      row,
      new Date(),
      correlationId,
    );
    if (recorded.outcome === "cancelled") {
      this.logger.warn({
        event: "feedback.outbox.untranscribable",
        correlationId,
        outboxId: row.id,
        reason: recorded.reason,
      });
      return { outcome: "cancelled" };
    }

    const result = await this.transport.sendText({
      to: conversation.phoneAtLaunch,
      text: row.body,
      outboxId: row.id,
    });

    if (result.outcome === "accepted") {
      await this.markSent(row, {
        providerLogId: result.providerLogId,
        ...(result.providerMessageId
          ? { providerMessageId: result.providerMessageId }
          : {}),
        deliveryStatus: "sent",
        at: new Date(),
      });
      this.logger.log({
        event: "feedback.outbox.sent",
        correlationId,
        outboxId: row.id,
      });
      return { outcome: "sent" };
    }

    if (result.outcome === "not-accepted") {
      await this.markFailed(row.id, row.conversationId, correlationId);
      this.logger.warn({
        event: "feedback.outbox.not_accepted",
        correlationId,
        outboxId: row.id,
        reason: result.reason,
      });
      return { outcome: "failed" };
    }

    // Unknown: the provider may have accepted the message. Persist any partial
    // id, mark delivery as pending, and wait for reconcile / upsert observation.
    await this.parkUnknown(row.id, result.providerLogId);
    this.logger.warn({
      event: "feedback.outbox.unknown_outcome",
      correlationId,
      outboxId: row.id,
      reason: result.reason,
      hasProviderLogId: Boolean(result.providerLogId),
    });
    return { outcome: "awaiting_observation" };
  }

  private async reconcile(
    row: MessageOutboxRow,
    correlationId: string,
  ): Promise<DeliverMessageOutboxResult> {
    if (row.providerMessageId && row.status === "sent") {
      return { outcome: "already_terminal" };
    }

    if (row.providerLogId && this.transport.getMessageInfo) {
      try {
        const info = await this.transport.getMessageInfo(row.providerLogId);
        if (info) {
          if (info.status === "error") {
            await this.markFailed(row.id, row.conversationId, correlationId);
            return { outcome: "failed" };
          }
          await this.markSent(row, {
            providerLogId: info.providerLogId,
            providerMessageId: info.providerMessageId,
            deliveryStatus: info.status,
            at: info.occurredAt,
          });
          this.logger.log({
            event: "feedback.outbox.reconciled",
            correlationId,
            outboxId: row.id,
          });
          return { outcome: "reconciled" };
        }
      } catch (error) {
        this.logger.warn({
          event: "feedback.outbox.reconcile_failed",
          correlationId,
          outboxId: row.id,
          error: { name: error instanceof Error ? error.name : "Error" },
        });
      }
    }

    // Still unknown: leave the row in `sending` for upsert correlation (WP4)
    // or a later reconcile. Never sendText.
    this.logger.log({
      event: "feedback.outbox.awaiting_observation",
      correlationId,
      outboxId: row.id,
    });
    return { outcome: "awaiting_observation" };
  }

  private async markSent(
    row: MessageOutboxRow,
    input: {
      readonly providerLogId: string;
      readonly providerMessageId?: string;
      readonly deliveryStatus: Exclude<MessageOutboxDeliveryStatus, "error">;
      readonly at: Date;
    },
  ): Promise<void> {
    const deliveryStatus = coalesceDeliveryStatus(
      row.deliveryStatus,
      input.deliveryStatus,
    );
    const timestamps = deliveryTimestampFields(deliveryStatus, input.at, row);

    await this.database.transaction(async (transaction) => {
      await this.outbox.updateOutboxDelivery(transaction, row.id, {
        deliveryStatus,
        providerLogId: input.providerLogId,
        ...(input.providerMessageId
          ? { providerMessageId: input.providerMessageId }
          : {}),
        status: "sent",
        ...timestamps,
      });
    });
  }

  /**
   * A send that will never be retried, and the conversation it belongs to.
   *
   * The failed status alone lives on an outbox row nobody opens. From the
   * inbox the conversation looked perfectly healthy — a participant who "went
   * quiet" after a question they were never actually sent is indistinguishable
   * from one who read it and could not be bothered, which is exactly the
   * question staff open the inbox to answer. So the failure is raised where a
   * person will see it.
   *
   * Attention is best-effort on purpose: the outbox row is the durable record
   * of the failure, and a Mongo hiccup must not turn a handled dead end into a
   * thrown job that retries a send the provider already refused.
   */
  private async markFailed(
    outboxId: string,
    /** `null` when the conversation itself is what went missing. */
    conversationId: string | null,
    correlationId: string,
  ): Promise<void> {
    await this.database.transaction(async (transaction) => {
      await this.outbox.updateOutboxStatus(transaction, outboxId, "failed");
    });
    if (!conversationId) {
      return;
    }

    try {
      await this.conversations.setNeedsAttention({
        conversationId,
        needsAttention: true,
        at: new Date(),
      });
    } catch (error) {
      this.logger.error({
        event: "feedback.outbox.attention_failed",
        correlationId,
        outboxId,
        conversationId,
        error: { name: error instanceof Error ? error.name : "Error" },
      });
    }
  }

  private async parkUnknown(
    outboxId: string,
    providerLogId: string | undefined,
  ): Promise<void> {
    await this.database.transaction(async (transaction) => {
      await this.outbox.updateOutboxDelivery(transaction, outboxId, {
        deliveryStatus: "pending",
        ...(providerLogId ? { providerLogId } : {}),
        status: "sending",
      });
    });
  }
}
