import { Injectable, Logger } from "@nestjs/common";

import type {
  MessageOutboxKind,
  MessageOutboxRow,
} from "@join-the-six/database";

import { DatabaseService } from "../../../infrastructure/database/database.service.js";
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

/**
 * The single writer of outbound transcript entries.
 *
 * Plan §6 requires actor-labelled messages with `outboxId` provenance, and §7
 * puts every outbound message behind `message_outbox`. This service is the one
 * place that joins the two: whenever a row is created for a conversation, the
 * same text lands in the MongoDB transcript with the actor the row's `kind`
 * implies. Without it the transcript is one-sided — the admin pane shows only
 * the participant, and the extraction prompt's "full actor-labelled transcript"
 * carries no bot turns.
 *
 * Callers: campaign launch / start-conversation (intro), the reminder sweep,
 * extraction (reply, closing and handoff copy), the materializer (STOP
 * acknowledgement), the staff inbox send, and the WP6 delivery job as the
 * forward repair described below.
 */
@Injectable()
export class FeedbackOutboundTranscriptService {
  private readonly logger = new Logger(FeedbackOutboundTranscriptService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly repository: FeedbackOutboxRepository,
    private readonly conversations: FeedbackConversationRepository,
  ) {}

  /**
   * Records one outbound row in the transcript.
   *
   * **Store order.** PostgreSQL first, MongoDB second, exactly like the rest of
   * this module: the durable outbox row is what actually causes a send, so it
   * must never depend on a MongoDB write succeeding first.
   *
   * **Crash repair.** A crash between the PostgreSQL commit and this append
   * leaves a row with no transcript entry. Because the append is idempotent by
   * `outboxId`, every producer repairs forward by simply running again — launch
   * replay and `startConversation` re-resolve the intro row, the reminder sweep
   * re-selects a conversation whose `remindedAt` is still null, and an
   * extraction retry replays the whole run behind its dedupe keys. The STOP
   * acknowledgement is the one producer that cannot replay (its ingress row is
   * already terminal), so the delivery job calls this method again before it
   * sends. That also makes the general invariant hold: nothing is transmitted
   * to a participant that the transcript did not record.
   *
   * **Body source.** Always the stored row's body, never the text a caller
   * proposed. A replayed extraction may generate different reply wording while
   * `insertOutboxIfAbsent` returns the row that was already enqueued and will
   * actually be sent; appending the fresh wording would be rejected as a
   * conflicting replay of the same `outboxId`.
   *
   * **Capacity.** Nothing is silently dropped. A transcript that cannot hold
   * the message (the 150-message cap or the BSON backstop) already raises
   * `needsAttention` inside the repository; here the outbox row is additionally
   * **cancelled**, because a message that cannot be recorded must not be sent —
   * a one-sided transcript is the exact failure this path exists to prevent.
   */
  async record(
    row: FeedbackOutboundTranscriptRow,
    at: Date,
    correlationId?: string,
  ): Promise<FeedbackOutboundTranscriptResult> {
    const actor = resolveTranscriptActor(row.kind);
    const text = row.body.trim();

    if (text.length > FEEDBACK_CONVERSATION_MESSAGE_MAX_TEXT_LENGTH) {
      // `message_outbox` accepts 10 000 characters; a transcript entry — and a
      // WhatsApp text body — stops at 4 096. Failing forever would make the job
      // a poison pill, so the row is cancelled and flagged like a full
      // transcript.
      return this.cancel(row, at, "body_too_long", correlationId);
    }

    try {
      const appended = await this.conversations.appendMessage({
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
      return this.cancel(row, at, "transcript_capacity", correlationId);
    }
  }

  private async cancel(
    row: FeedbackOutboundTranscriptRow,
    at: Date,
    reason: FeedbackOutboundTranscriptRejection,
    correlationId: string | undefined,
  ): Promise<FeedbackOutboundTranscriptResult> {
    await this.database.transaction(async (transaction) => {
      await this.repository.updateOutboxStatus(
        transaction,
        row.id,
        "cancelled",
      );
    });

    // `appendMessage` names the capacity path itself (`transcript_full`); an
    // oversized body never reached it, so the reason is raised here instead.
    //
    // It is the *same* reason as a send the provider refused for good, because
    // the operator's position is identical either way: the bot decided to say
    // something, the row is cancelled, and the participant will never see it —
    // so somebody has to reach them by hand. Why it did not go out is on the
    // outbox row for whoever wants it.
    if (reason === "body_too_long") {
      await this.conversations.raiseAttention({
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
