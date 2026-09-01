import { Injectable } from "@nestjs/common";
import type { AppTransaction, MessageOutboxRow } from "@slopform/database";

import type { FeedbackConversationDocument } from "../post-event-feedback-conversation.document.js";
import { FeedbackOutboundLogRepository } from "./outbound-log.repository.js";
import {
  feedbackOutboundDecisionSchema,
  type FeedbackOutboundDecision,
} from "./outbound-log.schemas.js";
import { buildOutboundConversationSnapshot } from "./outbound-log.snapshot.js";

/**
 * Write path for `message_outbox_log`. Every enqueue site that calls
 * `insertOutboxIfAbsent` should call `record` in the same transaction; a
 * dedupe replay (`inserted: false`) is a no-op because the log already has
 * that row's story.
 */
@Injectable()
export class FeedbackOutboundLogService {
  constructor(private readonly repository: FeedbackOutboundLogRepository) {}

  async record(
    transaction: AppTransaction,
    input: {
      readonly outbox: {
        readonly row: MessageOutboxRow;
        readonly inserted: boolean;
      };
      readonly conversation: FeedbackConversationDocument;
      readonly decision: FeedbackOutboundDecision;
      readonly correlationId: string;
    },
  ): Promise<void> {
    if (!input.outbox.inserted) {
      return;
    }

    const decision = feedbackOutboundDecisionSchema.parse(input.decision);
    const conversationState = buildOutboundConversationSnapshot(
      input.conversation,
    );

    await this.repository.insertOutboxLogIfAbsent(transaction, {
      outboxId: input.outbox.row.id,
      conversationId: input.outbox.row.conversationId,
      campaignId: input.outbox.row.campaignId,
      origin: decision.origin,
      correlationId: input.correlationId,
      decision,
      conversationState,
    });
  }
}
