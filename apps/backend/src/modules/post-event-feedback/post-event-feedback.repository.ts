import { Injectable } from "@nestjs/common";
import {
  feedbackAnswers,
  feedbackCampaigns,
  feedbackNotes,
  feedbackSimOutbound,
  eventAttendees,
  messageOutbox,
  participants,
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
  type FeedbackSimOutboundRow,
  type MessageOutboxDeliveryStatus,
  type MessageOutboxKind,
  type MessageOutboxRow,
  type MessageOutboxStatus,
  type ProviderMessageDirection,
  type ProviderMessageIngressRow,
  type ProviderMessageProcessingStatus,
} from "@join-the-six/database";
import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";

import { DatabaseService } from "../../infrastructure/database/database.service.js";

/** Stale `sending` rows older than this are reclaimed for re-enqueue / reconcile. */
export const FEEDBACK_OUTBOX_RECOVERY_MS = 5 * 60_000;
export const FEEDBACK_OUTBOX_BATCH_SIZE = 50;
export const FEEDBACK_SWEEP_BATCH_SIZE = 50;

export type FeedbackEligibleAttendee = {
  readonly participantId: string;
  readonly preferredName: string | null;
  readonly emailNormalized: string;
  readonly phoneE164: string;
};

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
   * Present attendees who opted in and have an E.164 phone — the launch and
   * start-conversation eligibility gate (finished-event check lives in the
   * service).
   */
  async listEligibleAttendeesForEvent(
    eventId: string,
    executor: DatabaseExecutor = this.database.db,
  ): Promise<FeedbackEligibleAttendee[]> {
    const rows = await executor
      .select({
        participantId: eventAttendees.participantId,
        preferredName: participants.preferredName,
        emailNormalized: participants.emailNormalized,
        phoneE164: participants.phoneE164,
      })
      .from(eventAttendees)
      .innerJoin(
        participants,
        eq(participants.id, eventAttendees.participantId),
      )
      .where(
        and(
          eq(eventAttendees.eventId, eventId),
          eq(eventAttendees.present, true),
          eq(participants.postEventFeedbackWhatsappOptIn, true),
          isNotNull(participants.phoneE164),
        ),
      )
      .orderBy(
        asc(participants.preferredName),
        asc(participants.emailNormalized),
      );

    return rows.flatMap((row) => {
      if (!row.phoneE164) {
        return [];
      }
      return [
        {
          participantId: row.participantId,
          preferredName: row.preferredName,
          emailNormalized: row.emailNormalized,
          phoneE164: row.phoneE164,
        },
      ];
    });
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

  async cancelQueuedOutboxForCampaign(
    transaction: AppTransaction,
    campaignId: string,
  ): Promise<number> {
    const cancelled = await transaction
      .update(messageOutbox)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(
        and(
          eq(messageOutbox.campaignId, campaignId),
          inArray(messageOutbox.status, ["pending", "held"]),
        ),
      )
      .returning({ id: messageOutbox.id });

    return cancelled.length;
  }

  /**
   * Rows left `pending` after a lost materialize enqueue. The recovery sweep
   * re-enqueues under the same stable job id.
   */
  async listPendingIngressOlderThan(
    olderThan: Date,
    limit = FEEDBACK_SWEEP_BATCH_SIZE,
    executor: DatabaseExecutor = this.database.db,
  ): Promise<ProviderMessageIngressRow[]> {
    return executor
      .select()
      .from(providerMessageIngress)
      .where(
        and(
          eq(providerMessageIngress.processingStatus, "pending"),
          lte(providerMessageIngress.createdAt, olderThan),
        ),
      )
      .orderBy(
        asc(providerMessageIngress.createdAt),
        asc(providerMessageIngress.id),
      )
      .limit(limit);
  }

  /** Lists due outbox rows without locking. Prefer `claimOutboxBatch` for relay. */
  async listDueOutbox(
    statuses: readonly MessageOutboxStatus[] = ["pending"],
    limit = FEEDBACK_OUTBOX_BATCH_SIZE,
    executor: DatabaseExecutor = this.database.db,
  ): Promise<MessageOutboxRow[]> {
    return executor
      .select()
      .from(messageOutbox)
      .where(inArray(messageOutbox.status, [...statuses]))
      .orderBy(asc(messageOutbox.createdAt), asc(messageOutbox.id))
      .limit(limit);
  }

  /**
   * Leases due outbox rows with `FOR UPDATE SKIP LOCKED`. `held` rows are never
   * selected. Rows whose campaign is not `launched` (paused/closed kill switch)
   * stay pending so resume can lease them later. Stale `sending` rows past the
   * recovery horizon are reclaimed so a lost BullMQ job can be republished; the
   * deliver consumer reconciles before ever calling send again.
   */
  async claimOutboxBatch(
    now: Date,
    limit = FEEDBACK_OUTBOX_BATCH_SIZE,
    recoveryMs = FEEDBACK_OUTBOX_RECOVERY_MS,
  ): Promise<MessageOutboxRow[]> {
    return this.database.transaction(async (transaction) => {
      const recoveryBefore = new Date(now.getTime() - recoveryMs);
      const candidates = await transaction
        .select()
        .from(messageOutbox)
        .where(
          or(
            eq(messageOutbox.status, "pending"),
            and(
              eq(messageOutbox.status, "sending"),
              lte(messageOutbox.updatedAt, recoveryBefore),
            ),
          ),
        )
        .orderBy(asc(messageOutbox.createdAt), asc(messageOutbox.id))
        .limit(limit)
        .for("update", { skipLocked: true });

      if (candidates.length === 0) {
        return [];
      }

      const claimable: MessageOutboxRow[] = [];
      for (const candidate of candidates) {
        const campaign = await this.findCampaignById(
          candidate.campaignId,
          transaction,
        );
        if (campaign?.status === "launched") {
          claimable.push(candidate);
        }
      }

      if (claimable.length === 0) {
        return [];
      }

      return transaction
        .update(messageOutbox)
        .set({ status: "sending", updatedAt: now })
        .where(
          inArray(
            messageOutbox.id,
            claimable.map((candidate) => candidate.id),
          ),
        )
        .returning();
    });
  }

  /**
   * Returns a leased row to `pending` after a failed enqueue, but only when no
   * provider attempt has been recorded. An unknown-outcome attempt stays in
   * `sending` so recovery reconciles instead of releasing it for a blind retry.
   */
  async releaseOutboxLease(
    id: string,
    now = new Date(),
  ): Promise<MessageOutboxRow | undefined> {
    const [record] = await this.database.db
      .update(messageOutbox)
      .set({ status: "pending", updatedAt: now })
      .where(
        and(
          eq(messageOutbox.id, id),
          eq(messageOutbox.status, "sending"),
          isNull(messageOutbox.deliveryStatus),
          isNull(messageOutbox.providerLogId),
          isNull(messageOutbox.providerMessageId),
        ),
      )
      .returning();

    return record;
  }

  async findOutboxByProviderLogId(
    providerLogId: string,
    executor: DatabaseExecutor = this.database.db,
  ): Promise<MessageOutboxRow | undefined> {
    const [record] = await executor
      .select()
      .from(messageOutbox)
      .where(eq(messageOutbox.providerLogId, providerLogId))
      .limit(1);

    return record;
  }

  /** Dev-only simulated transport sink (WP8). */
  async insertSimOutbound(
    input: {
      readonly id?: string;
      readonly outboxId: string;
      readonly phoneE164: string;
      readonly body: string;
      readonly providerMessageId: string;
      readonly sentAt: Date;
    },
    executor: DatabaseExecutor = this.database.db,
  ): Promise<FeedbackSimOutboundRow> {
    const [record] = await executor
      .insert(feedbackSimOutbound)
      .values({
        id: input.id,
        outboxId: input.outboxId,
        phoneE164: input.phoneE164,
        body: input.body,
        providerMessageId: input.providerMessageId,
        sentAt: input.sentAt,
      })
      .returning();

    if (!record) {
      throw new Error("Simulated outbound insert returned no row");
    }

    return record;
  }

  async listSimOutboundByPhoneE164(
    phoneE164: string,
    executor: DatabaseExecutor = this.database.db,
  ): Promise<readonly FeedbackSimOutboundRow[]> {
    return executor
      .select()
      .from(feedbackSimOutbound)
      .where(eq(feedbackSimOutbound.phoneE164, phoneE164))
      .orderBy(asc(feedbackSimOutbound.sentAt), asc(feedbackSimOutbound.id));
  }

  async listIngressByPhoneE164(
    phoneE164: string,
    executor: DatabaseExecutor = this.database.db,
  ): Promise<readonly ProviderMessageIngressRow[]> {
    return executor
      .select()
      .from(providerMessageIngress)
      .where(eq(providerMessageIngress.phoneE164, phoneE164))
      .orderBy(
        asc(providerMessageIngress.observedAt),
        asc(providerMessageIngress.id),
      );
  }

  async findSimOutboundById(
    id: string,
    executor: DatabaseExecutor = this.database.db,
  ): Promise<FeedbackSimOutboundRow | undefined> {
    const [record] = await executor
      .select()
      .from(feedbackSimOutbound)
      .where(eq(feedbackSimOutbound.id, id))
      .limit(1);

    return record;
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
