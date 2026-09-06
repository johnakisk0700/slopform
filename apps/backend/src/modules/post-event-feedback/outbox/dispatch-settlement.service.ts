import { Injectable } from "@nestjs/common";

import type { AppTransaction, MessageOutboxRow } from "@slopform/database";

import { DatabaseService } from "../../../infrastructure/database/database.service.js";
import { FeedbackConversationRepository } from "../post-event-feedback-conversation.repository.js";
import { FeedbackLogger } from "../feedback-operation-log.js";
import { FeedbackOutboxRepository } from "./outbox.repository.js";
import type { FeedbackOutboxDispatchItemResult } from "./dispatcher.types.js";
import type { FeedbackTransportSendResult } from "./transport.js";

/**
 * Authoritative outcomes after the durable `attempting` marker. Token loss
 * cannot override a provider observation already written; uncertain delivery
 * parks the open bot in the same transaction as the ambiguous status.
 *
 * Callers: FeedbackDispatchAttemptService (accepted / rejected / unknown /
 * transport throw) and FeedbackDispatchRecoveryService (expired-attempt park).
 */
@Injectable()
export class FeedbackDispatchSettlementService {
  private readonly logger = new FeedbackLogger(
    FeedbackDispatchSettlementService.name,
  );

  constructor(
    private readonly database: DatabaseService,
    private readonly outbox: FeedbackOutboxRepository,
    private readonly conversations: FeedbackConversationRepository,
  ) {}

  async finalizeAccepted(
    row: MessageOutboxRow,
    claimToken: string,
    result: Extract<
      FeedbackTransportSendResult,
      { readonly outcome: "accepted" }
    >,
  ): Promise<FeedbackOutboxDispatchItemResult> {
    const completedAt = new Date();
    const sent = await this.outbox.markDispatchSent(row.id, claimToken, {
      completedAt,
      providerLogId: result.providerLogId,
      ...(result.providerMessageId
        ? { providerMessageId: result.providerMessageId }
        : {}),
      deliveryStatus: "sent",
      sentAt: completedAt,
    });
    if (!sent) {
      this.logFenceLoss(row.id, "accepted");
      return { outboxId: row.id, outcome: "claim_lost" };
    }
    this.logger.log({
      event: "feedback.outbox.dispatched",
      outboxId: row.id,
    });
    return { outboxId: row.id, outcome: "sent" };
  }

  async finalizeNotAccepted(
    row: MessageOutboxRow,
    claimToken: string,
    result: Extract<
      FeedbackTransportSendResult,
      { readonly outcome: "not-accepted" }
    >,
  ): Promise<FeedbackOutboxDispatchItemResult> {
    const failed = await this.outbox.markDispatchFailed(
      row.id,
      claimToken,
      new Date(),
      boundedFailure(`transport_not_accepted:${result.reason}`),
    );
    if (!failed) {
      this.logFenceLoss(row.id, "not_accepted");
      return { outboxId: row.id, outcome: "claim_lost" };
    }
    await this.raiseUndeliveredAttention(row);
    return { outboxId: row.id, outcome: "failed" };
  }

  async finalizeUnknown(
    row: MessageOutboxRow,
    claimToken: string,
    result: Extract<
      FeedbackTransportSendResult,
      { readonly outcome: "unknown" }
    >,
  ): Promise<FeedbackOutboxDispatchItemResult> {
    return this.markAmbiguous(
      row,
      claimToken,
      `transport_unknown:${result.reason}`,
      undefined,
      result.providerLogId,
    );
  }

  async markAmbiguous(
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

  async parkUncertainDelivery(
    row: MessageOutboxRow,
    transaction: AppTransaction,
  ): Promise<void> {
    const at = new Date();
    const conversation = await this.conversations.findById(
      row.conversationId,
      transaction,
    );
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
      await this.conversations.markAwaitingHuman(transaction, {
        conversationId: row.conversationId,
        at,
      });
    }
    await this.conversations.raiseAttention(transaction, {
      conversationId: row.conversationId,
      kind: "undelivered_message",
      messageId: null,
      at,
    });
  }

  private async raiseUndeliveredAttention(
    row: MessageOutboxRow,
  ): Promise<void> {
    try {
      await this.database.transaction((transaction) =>
        this.conversations.raiseAttention(transaction, {
          conversationId: row.conversationId,
          kind: "undelivered_message",
          messageId: null,
          at: new Date(),
        }),
      );
    } catch (error) {
      // The failed outbox row is authoritative. Conversation attention is a useful
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
