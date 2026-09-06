import { Injectable } from "@nestjs/common";
import type {
  AppTransaction,
  MessageOutboxRow,
  MessageOutboxStatus,
} from "@slopform/database";

import type { FeedbackConversationDocument } from "../post-event-feedback-conversation.document.js";
import {
  assertEnqueueDispatchContext,
  kindForDispatchPurpose,
  type DispatchEnqueueRequest,
} from "./dispatch-context.js";
import { FeedbackOutboundLogService } from "./outbound-log.service.js";
import type { FeedbackOutboundDecision } from "./outbound-log.schemas.js";
import { FeedbackOutboxRepository } from "./outbox.repository.js";

export type OutboundHistoryWrite = {
  readonly conversation: FeedbackConversationDocument;
  readonly decision: FeedbackOutboundDecision;
  readonly correlationId: string;
};

/**
 * STOP records history after close/cancel so the write sits after those
 * mutations. The snapshot is still the caller-supplied conversation document
 * (today the pre-close object). This is not a callback; the caller calls
 * `recordHistory` explicitly.
 */
export type EnqueueHistory =
  OutboundHistoryWrite | { readonly deferred: "stop_ack_after_mutations" };

export type OutboundEnqueueMessage = {
  readonly conversationId: string;
  readonly campaignId: string;
  readonly body: string;
  readonly dedupeKey: string;
  readonly id?: string;
  readonly status?: MessageOutboxStatus;
  readonly createdByStaff?: string | null;
};

/**
 * Admits one outbound row plus immutable dispatch context on the caller's
 * transaction. History is the existing diagnostic projection, not authority.
 * Does not own transcript capacity, control, consent or send.
 */
@Injectable()
export class FeedbackOutboundIntentService {
  constructor(
    private readonly outbox: FeedbackOutboxRepository,
    private readonly outboundLog: FeedbackOutboundLogService,
  ) {}

  async enqueue(
    transaction: AppTransaction,
    input: {
      readonly dispatch: DispatchEnqueueRequest;
      readonly message: OutboundEnqueueMessage;
      readonly history: EnqueueHistory;
    },
  ): Promise<{ readonly row: MessageOutboxRow; readonly inserted: boolean }> {
    const kind = kindForDispatchPurpose(input.dispatch.purpose);
    assertEnqueueDispatchContext(
      input.dispatch,
      kind,
      input.message.dedupeKey,
      input.message.conversationId,
    );
    const inserted = await this.outbox.insertOutboxIfAbsent(transaction, {
      ...(input.message.id ? { id: input.message.id } : {}),
      conversationId: input.message.conversationId,
      campaignId: input.message.campaignId,
      kind,
      body: input.message.body,
      dedupeKey: input.message.dedupeKey,
      ...(input.message.status === undefined
        ? {}
        : { status: input.message.status }),
      ...(input.message.createdByStaff === undefined
        ? {}
        : { createdByStaff: input.message.createdByStaff }),
      dispatchContext: input.dispatch,
    });
    if ("deferred" in input.history) {
      return inserted;
    }
    await this.recordHistory(transaction, {
      outbox: inserted,
      conversation: input.history.conversation,
      decision: input.history.decision,
      correlationId: input.history.correlationId,
    });
    return inserted;
  }

  async recordHistory(
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
    await this.outboundLog.record(transaction, input);
  }
}
