import { Injectable, Logger } from "@nestjs/common";

import type {
  AppTransaction,
  MessageOutboxKind,
  MessageOutboxRow,
} from "@slopform/database";

import {
  FeedbackConversationCapacityError,
  FeedbackConversationRepository,
} from "../post-event-feedback-conversation.repository.js";
import {
  FEEDBACK_CONVERSATION_MESSAGE_MAX_TEXT_LENGTH,
  type FeedbackConversationActor,
  type FeedbackConversationDocument,
} from "../post-event-feedback-conversation.document.js";
import { FeedbackOutboxRepository } from "./outbox.repository.js";

/**
 * Every outbound message reaches a participant through one `message_outbox`
 * row, so the row's `kind` is the only thing that decides which actor spoke.
 *
 * `system` maps to `bot`, not to the `system` actor: the STOP acknowledgement
 * is the bot speaking on the channel, and the schema-v2 message validator
 * reserves `actor: system` for entries with **no** transport provenance. An
 * outbox-backed message always carries `outboxId`, so `system` would be
 * rejected by the aggregate itself.
 */
export const FEEDBACK_OUTBOX_KIND_ACTORS: Record<
  MessageOutboxKind,
  FeedbackConversationActor
> = {
  intro: "bot",
  reminder: "bot",
  reply: "bot",
  system: "bot",
  staff: "staff",
};

export type FeedbackOutboundTranscriptRejection =
  "transcript_capacity" | "body_too_long";

export type FeedbackOutboundTranscriptResult =
  | {
      readonly outcome: "appended" | "already_present";
      readonly conversation: FeedbackConversationDocument;
    }
  | {
      readonly outcome: "cancelled";
      readonly reason: FeedbackOutboundTranscriptRejection;
    };

export type FeedbackOutboundTranscriptDispatchFence = {
  readonly claimToken: string;
};

export type FeedbackOutboundTranscriptDispatchResult =
  FeedbackOutboundTranscriptResult | { readonly outcome: "claim_lost" };

/** The `message_outbox` columns a transcript entry is derived from. */
export type FeedbackOutboundTranscriptRow = Pick<
  MessageOutboxRow,
  "id" | "conversationId" | "kind" | "body"
>;

export class UnsupportedMessageOutboxKindError extends Error {
  constructor(kind: string) {
    super(`Message outbox kind ${kind} has no transcript actor`);
    this.name = UnsupportedMessageOutboxKindError.name;
  }
}

/** Writes the stored outbox body and its actor in the producer's transaction. */
@Injectable()
export class FeedbackOutboundTranscriptService {
  private readonly logger = new Logger(FeedbackOutboundTranscriptService.name);

  constructor(
    private readonly repository: FeedbackOutboxRepository,
    private readonly conversations: FeedbackConversationRepository,
  ) {}

  /** A message that cannot be recorded is cancelled before dispatch. */
  async record(
    transaction: AppTransaction,
    row: FeedbackOutboundTranscriptRow,
    at: Date,
    correlationId?: string,
  ): Promise<FeedbackOutboundTranscriptResult>;
  async record(
    transaction: AppTransaction,
    row: FeedbackOutboundTranscriptRow,
    at: Date,
    correlationId: string | undefined,
    dispatchFence: FeedbackOutboundTranscriptDispatchFence,
  ): Promise<FeedbackOutboundTranscriptDispatchResult>;
  async record(
    transaction: AppTransaction,
    row: FeedbackOutboundTranscriptRow,
    at: Date,
    correlationId?: string,
    dispatchFence?: FeedbackOutboundTranscriptDispatchFence,
  ): Promise<FeedbackOutboundTranscriptDispatchResult> {
    const actor = resolveTranscriptActor(row.kind);
    const text = row.body.trim();

    if (text.length > FEEDBACK_CONVERSATION_MESSAGE_MAX_TEXT_LENGTH) {
      return this.cancel(
        transaction,
        row,
        at,
        "body_too_long",
        correlationId,
        dispatchFence,
      );
    }

    try {
      const appended = await this.conversations.appendMessage(transaction, {
        conversationId: row.conversationId,
        actor,
        text,
        at,
        outboxId: row.id,
      });
      return {
        outcome: appended.appended ? "appended" : "already_present",
        conversation: appended.conversation,
      };
    } catch (error) {
      if (!(error instanceof FeedbackConversationCapacityError)) {
        throw error;
      }
      return this.cancel(
        transaction,
        row,
        at,
        "transcript_capacity",
        correlationId,
        dispatchFence,
      );
    }
  }

  private async cancel(
    transaction: AppTransaction,
    row: FeedbackOutboundTranscriptRow,
    at: Date,
    reason: FeedbackOutboundTranscriptRejection,
    correlationId: string | undefined,
    dispatchFence: FeedbackOutboundTranscriptDispatchFence | undefined,
  ): Promise<FeedbackOutboundTranscriptDispatchResult> {
    if (dispatchFence) {
      const cancelled = await this.repository.finishDispatchClaimBeforeAttempt(
        row.id,
        dispatchFence.claimToken,
        "cancelled",
        at,
        reason,
        transaction,
      );
      if (!cancelled) {
        return { outcome: "claim_lost" };
      }
    } else {
      await this.repository.updateOutboxStatus(
        transaction,
        row.id,
        "cancelled",
      );
    }

    if (reason === "body_too_long") {
      await this.conversations.raiseAttention(transaction, {
        conversationId: row.conversationId,
        kind: "undelivered_message",
        messageId: null,
        at,
      });
    }

    this.logger.warn({
      event: "feedback.outbound_transcript.cancelled",
      ...(correlationId ? { correlationId } : {}),
      conversationId: row.conversationId,
      outboxId: row.id,
      kind: row.kind,
      reason,
    });

    return { outcome: "cancelled", reason };
  }
}

/**
 * `message_outbox.kind` is a checked text column, so an unknown value means the
 * database constraint and this map drifted apart. That is a bug worth failing
 * on, not a message worth mislabelling in a transcript staff will read.
 */
function resolveTranscriptActor(kind: string): FeedbackConversationActor {
  const actor = FEEDBACK_OUTBOX_KIND_ACTORS[kind as MessageOutboxKind] as
    FeedbackConversationActor | undefined;
  if (!actor) {
    throw new UnsupportedMessageOutboxKindError(kind);
  }
  return actor;
}
