import { Injectable } from "@nestjs/common";
import {
  feedbackAnswers,
  feedbackCampaigns,
  feedbackNotes,
  messageOutbox,
  providerMessageIngress,
  type AppTransaction,
  type FeedbackAnswerQuestionKey,
  type FeedbackAnswerRow,
  type FeedbackCampaignQuestions,
  type FeedbackCampaignRow,
  type FeedbackCampaignStatus,
  type FeedbackExtractionMeta,
  type FeedbackNoteRow,
  type FeedbackNoteStatus,
  type FeedbackNoteType,
  type MessageOutboxDeliveryStatus,
  type MessageOutboxKind,
  type MessageOutboxRow,
  type MessageOutboxStatus,
  type ProviderMessageDirection,
  type ProviderMessageIngressRow,
  type ProviderMessageProcessingStatus,
} from "@join-the-six/database";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";

import { DatabaseService } from "../../infrastructure/database/database.service.js";

type DatabaseExecutor = AppTransaction | DatabaseService["db"];

@Injectable()
export class PostEventFeedbackRepository {
  constructor(private readonly database: DatabaseService) {}

  async createCampaign(
    transaction: AppTransaction,
    input: {
      readonly eventId: string;
      readonly questionSetVersion: number;
      readonly questions: FeedbackCampaignQuestions;
      readonly launchedAt: Date;
      readonly launchedBy: string;
      readonly status?: FeedbackCampaignStatus;
    },
  ): Promise<FeedbackCampaignRow> {
    const [record] = await transaction
      .insert(feedbackCampaigns)
      .values({
        eventId: input.eventId,
        questionSetVersion: input.questionSetVersion,
        questions: input.questions,
        launchedAt: input.launchedAt,
        launchedBy: input.launchedBy,
        status: input.status ?? "launched",
      })
      .returning();

    if (!record) {
      throw new Error("Feedback campaign insert returned no row");
    }

    return record;
  }

  async findCampaignById(
    id: string,
    executor: DatabaseExecutor = this.database.db,
  ): Promise<FeedbackCampaignRow | undefined> {
    const [record] = await executor
      .select()
      .from(feedbackCampaigns)
      .where(eq(feedbackCampaigns.id, id))
      .limit(1);

    return record;
  }

  async findCampaignByEventId(
    eventId: string,
    executor: DatabaseExecutor = this.database.db,
  ): Promise<FeedbackCampaignRow | undefined> {
    const [record] = await executor
      .select()
      .from(feedbackCampaigns)
      .where(eq(feedbackCampaigns.eventId, eventId))
      .limit(1);

    return record;
  }

  async updateCampaignStatus(
    transaction: AppTransaction,
    id: string,
    status: FeedbackCampaignStatus,
  ): Promise<FeedbackCampaignRow | undefined> {
    const [record] = await transaction
      .update(feedbackCampaigns)
      .set({ status, updatedAt: new Date() })
      .where(eq(feedbackCampaigns.id, id))
      .returning();

    return record;
  }

  /**
   * Inserts a directed answer. Conflicts on the NULLS NOT DISTINCT uniqueness
   * key are ignored so extraction replay stays idempotent.
   */
  async insertAnswerIfAbsent(
    transaction: AppTransaction,
    input: {
      readonly campaignId: string;
      readonly conversationId: string;
      readonly respondentParticipantId: string;
      readonly subjectParticipantId?: string | null;
      readonly questionKey: FeedbackAnswerQuestionKey;
      readonly valueInt?: number | null;
      readonly sourceMessageIds: readonly string[];
      readonly extractionMeta: FeedbackExtractionMeta;
    },
  ): Promise<FeedbackAnswerRow | undefined> {
    const [record] = await transaction
      .insert(feedbackAnswers)
      .values({
        campaignId: input.campaignId,
        conversationId: input.conversationId,
        respondentParticipantId: input.respondentParticipantId,
        subjectParticipantId: input.subjectParticipantId ?? null,
        questionKey: input.questionKey,
        valueInt: input.valueInt ?? null,
        sourceMessageIds: [...input.sourceMessageIds],
        extractionMeta: input.extractionMeta,
      })
      .onConflictDoNothing({
        target: [
          feedbackAnswers.conversationId,
          feedbackAnswers.questionKey,
          feedbackAnswers.subjectParticipantId,
        ],
      })
      .returning();

    return record;
  }

  async listAnswersByConversation(
    conversationId: string,
    executor: DatabaseExecutor = this.database.db,
  ): Promise<FeedbackAnswerRow[]> {
    return executor
      .select()
      .from(feedbackAnswers)
      .where(eq(feedbackAnswers.conversationId, conversationId))
      .orderBy(asc(feedbackAnswers.createdAt), asc(feedbackAnswers.id));
  }

  async listAnswersGivenByParticipant(
    respondentParticipantId: string,
    executor: DatabaseExecutor = this.database.db,
  ): Promise<FeedbackAnswerRow[]> {
    return executor
      .select()
      .from(feedbackAnswers)
      .where(
        eq(feedbackAnswers.respondentParticipantId, respondentParticipantId),
      )
      .orderBy(asc(feedbackAnswers.createdAt), asc(feedbackAnswers.id));
  }

  async listAnswersReceivedByParticipant(
    subjectParticipantId: string,
    executor: DatabaseExecutor = this.database.db,
  ): Promise<FeedbackAnswerRow[]> {
    return executor
      .select()
      .from(feedbackAnswers)
      .where(eq(feedbackAnswers.subjectParticipantId, subjectParticipantId))
      .orderBy(asc(feedbackAnswers.createdAt), asc(feedbackAnswers.id));
  }

  async insertNote(
    transaction: AppTransaction,
    input: {
      readonly campaignId: string;
      readonly conversationId: string;
      readonly respondentParticipantId: string;
      readonly subjectParticipantId?: string | null;
      readonly noteType: FeedbackNoteType;
      readonly text: string;
      readonly sourceMessageIds: readonly string[];
      readonly extractionMeta: FeedbackExtractionMeta;
      readonly status?: FeedbackNoteStatus;
    },
  ): Promise<FeedbackNoteRow> {
    const [record] = await transaction
      .insert(feedbackNotes)
      .values({
        campaignId: input.campaignId,
        conversationId: input.conversationId,
        respondentParticipantId: input.respondentParticipantId,
        subjectParticipantId: input.subjectParticipantId ?? null,
        noteType: input.noteType,
        text: input.text,
        sourceMessageIds: [...input.sourceMessageIds],
        extractionMeta: input.extractionMeta,
        status: input.status ?? "new",
      })
      .returning();

    if (!record) {
      throw new Error("Feedback note insert returned no row");
    }

    return record;
  }

  async listNotesByConversation(
    conversationId: string,
    executor: DatabaseExecutor = this.database.db,
  ): Promise<FeedbackNoteRow[]> {
    return executor
      .select()
      .from(feedbackNotes)
      .where(eq(feedbackNotes.conversationId, conversationId))
      .orderBy(asc(feedbackNotes.createdAt), asc(feedbackNotes.id));
  }

  async updateNoteStatus(
    transaction: AppTransaction,
    id: string,
    status: FeedbackNoteStatus,
  ): Promise<FeedbackNoteRow | undefined> {
    const [record] = await transaction
      .update(feedbackNotes)
      .set({ status, updatedAt: new Date() })
      .where(eq(feedbackNotes.id, id))
      .returning();

    return record;
  }

  /**
   * Durable webhook acknowledgement. Duplicate `(chat_jid, provider_message_id)`
   * inserts are ignored and the existing row is returned.
   */
  async insertIngressIfAbsent(
    transaction: AppTransaction,
    input: {
      readonly providerMessageId: string;
      readonly chatJid: string;
      readonly direction: ProviderMessageDirection;
      readonly phoneE164?: string | null;
      readonly text?: string | null;
      readonly observedAt: Date;
      readonly processingStatus?: ProviderMessageProcessingStatus;
      readonly matchedConversationId?: string | null;
    },
  ): Promise<{
    readonly row: ProviderMessageIngressRow;
    readonly inserted: boolean;
  }> {
    const [inserted] = await transaction
      .insert(providerMessageIngress)
      .values({
        providerMessageId: input.providerMessageId,
        chatJid: input.chatJid,
        direction: input.direction,
        phoneE164: input.phoneE164 ?? null,
        text: input.text ?? null,
        observedAt: input.observedAt,
        processingStatus: input.processingStatus ?? "pending",
        matchedConversationId: input.matchedConversationId ?? null,
      })
      .onConflictDoNothing({
        target: [
          providerMessageIngress.chatJid,
          providerMessageIngress.providerMessageId,
        ],
      })
      .returning();

    if (inserted) {
      return { row: inserted, inserted: true };
    }

    const existing = await this.findIngressByChatAndProviderMessage(
      transaction,
      input.chatJid,
      input.providerMessageId,
    );

    if (!existing) {
      throw new Error(
        "Provider ingress conflict did not resolve to an existing row",
      );
    }

    return { row: existing, inserted: false };
  }

  async findIngressById(
    id: string,
    executor: DatabaseExecutor = this.database.db,
  ): Promise<ProviderMessageIngressRow | undefined> {
    const [record] = await executor
      .select()
      .from(providerMessageIngress)
      .where(eq(providerMessageIngress.id, id))
      .limit(1);

    return record;
  }

  /**
   * Locks the ingress row for the materialization fence. Two concurrent
   * materialize executions serialize here, and the loser observes a terminal
   * `processing_status` instead of repeating the side effects.
   */
  async findIngressByIdForUpdate(
    transaction: AppTransaction,
    id: string,
  ): Promise<ProviderMessageIngressRow | undefined> {
    const [record] = await transaction
      .select()
      .from(providerMessageIngress)
      .where(eq(providerMessageIngress.id, id))
      .limit(1)
      .for("update");

    return record;
  }

  async findIngressByChatAndProviderMessage(
    executor: DatabaseExecutor,
    chatJid: string,
    providerMessageId: string,
  ): Promise<ProviderMessageIngressRow | undefined> {
    const [record] = await executor
      .select()
      .from(providerMessageIngress)
      .where(
        and(
          eq(providerMessageIngress.chatJid, chatJid),
          eq(providerMessageIngress.providerMessageId, providerMessageId),
        ),
      )
      .limit(1);

    return record;
  }

  async updateIngressProcessing(
    transaction: AppTransaction,
    id: string,
    input: {
      readonly processingStatus: ProviderMessageProcessingStatus;
      readonly matchedConversationId?: string | null;
      readonly text?: string | null;
      readonly phoneE164?: string | null;
    },
  ): Promise<ProviderMessageIngressRow | undefined> {
    const [record] = await transaction
      .update(providerMessageIngress)
      .set({
        processingStatus: input.processingStatus,
        ...(input.matchedConversationId !== undefined
          ? { matchedConversationId: input.matchedConversationId }
          : {}),
        ...(input.text !== undefined ? { text: input.text } : {}),
        ...(input.phoneE164 !== undefined
          ? { phoneE164: input.phoneE164 }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(providerMessageIngress.id, id))
      .returning();

    return record;
  }

  /**
   * Enqueues an outbound message. Duplicate `dedupe_key` inserts are ignored
   * and the existing row is returned.
   */
  async insertOutboxIfAbsent(
    transaction: AppTransaction,
    input: {
      readonly conversationId: string;
      readonly campaignId: string;
      readonly kind: MessageOutboxKind;
      readonly body: string;
      readonly dedupeKey: string;
      readonly status?: MessageOutboxStatus;
      readonly createdByStaff?: string | null;
    },
  ): Promise<{ readonly row: MessageOutboxRow; readonly inserted: boolean }> {
    const [inserted] = await transaction
      .insert(messageOutbox)
      .values({
        conversationId: input.conversationId,
        campaignId: input.campaignId,
        kind: input.kind,
        body: input.body,
        dedupeKey: input.dedupeKey,
        status: input.status ?? "pending",
        createdByStaff: input.createdByStaff ?? null,
      })
      .onConflictDoNothing({
        target: [messageOutbox.dedupeKey],
      })
      .returning();

    if (inserted) {
      return { row: inserted, inserted: true };
    }

    const existing = await this.findOutboxByDedupeKey(
      input.dedupeKey,
      transaction,
    );

    if (!existing) {
      throw new Error(
        "Message outbox conflict did not resolve to an existing row",
      );
    }

    return { row: existing, inserted: false };
  }

  async findOutboxById(
    id: string,
    executor: DatabaseExecutor = this.database.db,
  ): Promise<MessageOutboxRow | undefined> {
    const [record] = await executor
      .select()
      .from(messageOutbox)
      .where(eq(messageOutbox.id, id))
      .limit(1);

    return record;
  }

  async findOutboxByDedupeKey(
    dedupeKey: string,
    executor: DatabaseExecutor = this.database.db,
  ): Promise<MessageOutboxRow | undefined> {
    const [record] = await executor
      .select()
      .from(messageOutbox)
      .where(eq(messageOutbox.dedupeKey, dedupeKey))
      .limit(1);

    return record;
  }

  async findOutboxByProviderMessageId(
    providerMessageId: string,
    executor: DatabaseExecutor = this.database.db,
  ): Promise<MessageOutboxRow | undefined> {
    const [record] = await executor
      .select()
      .from(messageOutbox)
      .where(eq(messageOutbox.providerMessageId, providerMessageId))
      .limit(1);

    return record;
  }

  /**
   * Correlates an observed outbound message that carries no provider message id
   * yet: the oldest not-yet-linked row of that conversation with the exact same
   * body. Cancelled and held rows are excluded because they were never sent.
   */
  async findUnlinkedOutboxByConversationAndBody(
    conversationId: string,
    body: string,
    executor: DatabaseExecutor = this.database.db,
  ): Promise<MessageOutboxRow | undefined> {
    const [record] = await executor
      .select()
      .from(messageOutbox)
      .where(
        and(
          eq(messageOutbox.conversationId, conversationId),
          eq(messageOutbox.body, body),
          isNull(messageOutbox.providerMessageId),
          inArray(messageOutbox.status, ["pending", "sending", "sent"]),
        ),
      )
      .orderBy(asc(messageOutbox.createdAt), asc(messageOutbox.id))
      .limit(1);

    return record;
  }

  async listOutboxByConversation(
    conversationId: string,
    executor: DatabaseExecutor = this.database.db,
  ): Promise<MessageOutboxRow[]> {
    return executor
      .select()
      .from(messageOutbox)
      .where(eq(messageOutbox.conversationId, conversationId))
      .orderBy(asc(messageOutbox.createdAt), asc(messageOutbox.id));
  }

  async updateOutboxStatus(
    transaction: AppTransaction,
    id: string,
    status: MessageOutboxStatus,
  ): Promise<MessageOutboxRow | undefined> {
    const [record] = await transaction
      .update(messageOutbox)
      .set({ status, updatedAt: new Date() })
      .where(eq(messageOutbox.id, id))
      .returning();

    return record;
  }

  async updateOutboxDelivery(
    transaction: AppTransaction,
    id: string,
    input: {
      readonly deliveryStatus: MessageOutboxDeliveryStatus;
      readonly providerLogId?: string | null;
      readonly providerMessageId?: string | null;
      readonly sentAt?: Date | null;
      readonly deliveredAt?: Date | null;
      readonly readAt?: Date | null;
      readonly playedAt?: Date | null;
      readonly status?: MessageOutboxStatus;
    },
  ): Promise<MessageOutboxRow | undefined> {
    const [record] = await transaction
      .update(messageOutbox)
      .set({
        deliveryStatus: input.deliveryStatus,
        deliveryUpdatedAt: new Date(),
        updatedAt: new Date(),
        ...(input.providerLogId !== undefined
          ? { providerLogId: input.providerLogId }
          : {}),
        ...(input.providerMessageId !== undefined
          ? { providerMessageId: input.providerMessageId }
          : {}),
        ...(input.sentAt !== undefined ? { sentAt: input.sentAt } : {}),
        ...(input.deliveredAt !== undefined
          ? { deliveredAt: input.deliveredAt }
          : {}),
        ...(input.readAt !== undefined ? { readAt: input.readAt } : {}),
        ...(input.playedAt !== undefined ? { playedAt: input.playedAt } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
      })
      .where(eq(messageOutbox.id, id))
      .returning();

    return record;
  }

  async cancelQueuedOutboxForConversation(
    transaction: AppTransaction,
    conversationId: string,
  ): Promise<number> {
    const cancelled = await transaction
      .update(messageOutbox)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(
        and(
          eq(messageOutbox.conversationId, conversationId),
          inArray(messageOutbox.status, ["pending", "held"]),
        ),
      )
      .returning({ id: messageOutbox.id });

    return cancelled.length;
  }

  /** Claims the next due outbox row for relay (WP6). Status remains filterable. */
  async listDueOutbox(
    statuses: readonly MessageOutboxStatus[] = ["pending"],
    limit = 50,
    executor: DatabaseExecutor = this.database.db,
  ): Promise<MessageOutboxRow[]> {
    return executor
      .select()
      .from(messageOutbox)
      .where(inArray(messageOutbox.status, [...statuses]))
      .orderBy(asc(messageOutbox.createdAt), asc(messageOutbox.id))
      .limit(limit);
  }

  /** Advisory lock helper for later campaign/outbox coordination. */
  lockConversation(
    transaction: AppTransaction,
    conversationId: string,
  ): Promise<unknown> {
    return transaction.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`feedback-conversation:${conversationId}`}, 0))`,
    );
  }
}
