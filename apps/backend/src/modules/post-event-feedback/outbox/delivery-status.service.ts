import { Injectable, Logger } from "@nestjs/common";
import type { MessageOutboxDeliveryStatus } from "@join-the-six/database";

import { DatabaseService } from "../../../infrastructure/database/database.service.js";
import {
  coalesceDeliveryStatus,
  deliveryTimestampFields,
} from "./delivery-status.js";
import { FeedbackOutboxRepository } from "./outbox.repository.js";

export type ApplyOutboxDeliveryStatusInput = {
  readonly providerMessageId: string;
  readonly status: MessageOutboxDeliveryStatus;
  readonly occurredAt: Date;
};

export type ApplyOutboxDeliveryStatusResult =
  | { readonly outcome: "updated"; readonly outboxId: string }
  | { readonly outcome: "unmatched" }
  | { readonly outcome: "unchanged"; readonly outboxId: string };

/**
 * HTTP-edge consumer for `messages.update` / `message.status-changed`. Updates
 * delivery columns on the correlated `message_outbox` row without enqueueing
 * work or touching conversation state.
 */
@Injectable()
export class MessageOutboxDeliveryStatusService {
  private readonly logger = new Logger(MessageOutboxDeliveryStatusService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly repository: FeedbackOutboxRepository,
  ) {}

  async applyStatusChange(
    input: ApplyOutboxDeliveryStatusInput,
    correlationId: string,
  ): Promise<ApplyOutboxDeliveryStatusResult> {
    const row = await this.repository.findOutboxByProviderMessageId(
      input.providerMessageId,
    );
    if (!row) {
      this.logger.log({
        event: "feedback.outbox.status_unmatched",
        correlationId,
      });
      return { outcome: "unmatched" };
    }

    const appliedStatus = await this.database.transaction(
      async (transaction): Promise<MessageOutboxDeliveryStatus | null> => {
        await this.repository.lockConversation(transaction, row.conversationId);
        const current =
          (await this.repository.findOutboxByProviderMessageId(
            input.providerMessageId,
            transaction,
          )) ?? row;
        const nextStatus = coalesceDeliveryStatus(
          current.deliveryStatus,
          input.status,
        );
        if (nextStatus === current.deliveryStatus) return null;

        const timestamps = deliveryTimestampFields(
          nextStatus,
          input.occurredAt,
          current,
        );
        await this.repository.updateOutboxDelivery(transaction, current.id, {
          deliveryStatus: nextStatus,
          ...(current.status === "pending" ||
          current.status === "claimed" ||
          current.status === "attempting" ||
          current.status === "ambiguous" ||
          current.status === "sending" ||
          current.status === "sent"
            ? {
                status:
                  nextStatus === "error"
                    ? ("failed" as const)
                    : ("sent" as const),
              }
            : {}),
          ...timestamps,
        });
        return nextStatus;
      },
    );
    if (!appliedStatus) {
      return { outcome: "unchanged", outboxId: row.id };
    }

    this.logger.log({
      event: "feedback.outbox.status_updated",
      correlationId,
      outboxId: row.id,
      deliveryStatus: appliedStatus,
    });

    return { outcome: "updated", outboxId: row.id };
  }
}
