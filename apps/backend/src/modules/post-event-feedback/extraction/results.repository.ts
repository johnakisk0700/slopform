import { Injectable } from "@nestjs/common";
import {
  feedbackAnswers,
  feedbackAnswerWithdrawals,
  feedbackNotes,
  type AppTransaction,
  type FeedbackAnswerQuestionKey,
  type FeedbackAnswerRow,
  type FeedbackAnswerWithdrawalRow,
  type FeedbackExtractionMeta,
  type FeedbackNoteRow,
  type FeedbackNoteStatus,
  type FeedbackNoteType,
} from "@slopform/database";
import { and, asc, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";

import { DatabaseService } from "../../../infrastructure/database/database.service.js";
import { FEEDBACK_ANSWER_CORRECTIONS_KEY } from "./answer-corrections.js";

type DatabaseExecutor = AppTransaction | DatabaseService["db"];

/**
 * `'corrections'`, inlined rather than bound.
 *
 * The key is a compile-time constant of this module, never operator input, and
 * inlining it keeps the jsonb `?` and `->` operators away from an untyped bind
 * parameter.
 */
const CORRECTIONS_KEY = sql.raw(`'${FEEDBACK_ANSWER_CORRECTIONS_KEY}'`);

/** Rows no operator has corrected — the freeze predicate, in SQL. */
function notCorrected(): SQL {
  return sql`not (${feedbackAnswers.extractionMeta} ? ${CORRECTIONS_KEY})`;
}

/** The answer slot a row or a tombstone occupies. */
interface FeedbackAnswerSlot {
  readonly conversationId: string;
  readonly questionKey: string;
  readonly subjectParticipantId: string | null;
}

/**
 * The tombstone's half of the uniqueness key, with the `NULLS NOT DISTINCT`
 * behaviour written out: a subjectless question has one slot per conversation,
 * and `= null` would match nothing.
 */
function withdrawalSlot(slot: FeedbackAnswerSlot): SQL {
  return and(
    eq(feedbackAnswerWithdrawals.conversationId, slot.conversationId),
    eq(feedbackAnswerWithdrawals.questionKey, slot.questionKey),
    slot.subjectParticipantId === null
      ? isNull(feedbackAnswerWithdrawals.subjectParticipantId)
      : eq(
          feedbackAnswerWithdrawals.subjectParticipantId,
          slot.subjectParticipantId,
        ),
  )!;
}

@Injectable()
export class FeedbackResultsRepository {
  constructor(private readonly database: DatabaseService) {}

  /**
   * Removes answers about one person that the new answer contradicts.
   *
   * Uniqueness is per (conversation, question, subject), so a move between
   * lists would otherwise leave both rows. Operator-corrected rows are frozen:
   * the model may disagree, it may not delete them.
   */
  async deleteContradictedAnswers(
    transaction: AppTransaction,
    input: {
      readonly conversationId: string;
      readonly subjectParticipantId: string;
      readonly questionKeys: readonly FeedbackAnswerQuestionKey[];
    },
  ): Promise<number> {
    if (input.questionKeys.length === 0) {
      return 0;
    }
    const removed = await transaction
      .delete(feedbackAnswers)
      .where(
        and(
          eq(feedbackAnswers.conversationId, input.conversationId),
          eq(feedbackAnswers.subjectParticipantId, input.subjectParticipantId),
          inArray(feedbackAnswers.questionKey, [...input.questionKeys]),
          notCorrected(),
        ),
      )
      .returning();
    return removed.length;
  }

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
      readonly matchingHold?: boolean;
    },
  ): Promise<FeedbackAnswerRow | undefined> {
    // Withdrawal tombstone: the deleted row cannot carry a SQL freeze
    // predicate. Both paths hold the conversation advisory lock.
    const withdrawn = await this.findAnswerWithdrawal(transaction, {
      conversationId: input.conversationId,
      questionKey: input.questionKey,
      subjectParticipantId: input.subjectParticipantId ?? null,
    });
    if (withdrawn) {
      return undefined;
    }

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
        matchingHold: input.matchingHold ?? false,
      })
      // Newest testimony wins. Replay-safe: same run rewrites the same values;
      // the advisory lock serializes runs; the cursor stops an older run from
      // re-reading closed messages. `setWhere` skips operator-corrected rows.
      // Merge provenance and keep `corrections` — do not replace
      // `extraction_meta` wholesale.
      .onConflictDoUpdate({
        target: [
          feedbackAnswers.conversationId,
          feedbackAnswers.questionKey,
          feedbackAnswers.subjectParticipantId,
        ],
        setWhere: notCorrected(),
        set: {
          valueInt: input.valueInt ?? null,
          sourceMessageIds: [...input.sourceMessageIds],
          extractionMeta: sql`${sql.raw(`excluded.${feedbackAnswers.extractionMeta.name}`)} || case when ${feedbackAnswers.extractionMeta} ? ${CORRECTIONS_KEY} then jsonb_build_object(${CORRECTIONS_KEY}, ${feedbackAnswers.extractionMeta} -> ${CORRECTIONS_KEY}) else '{}'::jsonb end`,
          // Sticky OR: a later polite restatement cannot clear a hold.
          matchingHold: sql`${feedbackAnswers.matchingHold} or ${sql.raw(`excluded.${feedbackAnswers.matchingHold.name}`)}`,
        },
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

  async findAnswerById(
    id: string,
    executor: DatabaseExecutor = this.database.db,
  ): Promise<FeedbackAnswerRow | undefined> {
    const [record] = await executor
      .select()
      .from(feedbackAnswers)
      .where(eq(feedbackAnswers.id, id))
      .limit(1);

    return record;
  }

  /**
   * Operator value correction. Caller supplies `extractionMeta` with the
   * correction already appended so run provenance survives. Citations stay.
   */
  async updateAnswerValue(
    transaction: AppTransaction,
    input: {
      readonly id: string;
      readonly valueInt: number | null;
      readonly extractionMeta: FeedbackExtractionMeta;
    },
  ): Promise<FeedbackAnswerRow | undefined> {
    const [record] = await transaction
      .update(feedbackAnswers)
      .set({
        valueInt: input.valueInt,
        extractionMeta: input.extractionMeta,
        updatedAt: new Date(),
      })
      .where(eq(feedbackAnswers.id, input.id))
      .returning();

    return record;
  }

  /**
   * Hard-deletes one answer. Soft-delete would occupy the uniqueness key and
   * leak into reads. Caller writes the tombstone in the same transaction.
   */
  async deleteAnswer(
    transaction: AppTransaction,
    id: string,
  ): Promise<FeedbackAnswerRow | undefined> {
    const [record] = await transaction
      .delete(feedbackAnswers)
      .where(eq(feedbackAnswers.id, id))
      .returning();

    return record;
  }

  /**
   * Marks one answer slot decided-empty. `onConflictDoNothing` on the slot:
   * concurrent withdrawals are one decision.
   */
  async recordAnswerWithdrawal(
    transaction: AppTransaction,
    input: {
      readonly campaignId: string;
      readonly conversationId: string;
      readonly questionKey: string;
      readonly subjectParticipantId: string | null;
      readonly answerId: string;
      readonly withdrawnBy: string;
    },
  ): Promise<FeedbackAnswerWithdrawalRow | undefined> {
    const [record] = await transaction
      .insert(feedbackAnswerWithdrawals)
      .values({
        campaignId: input.campaignId,
        conversationId: input.conversationId,
        questionKey: input.questionKey,
        subjectParticipantId: input.subjectParticipantId,
        answerId: input.answerId,
        withdrawnBy: input.withdrawnBy,
      })
      .onConflictDoNothing({
        target: [
          feedbackAnswerWithdrawals.conversationId,
          feedbackAnswerWithdrawals.questionKey,
          feedbackAnswerWithdrawals.subjectParticipantId,
        ],
      })
      .returning();

    return record;
  }

  /**
   * Lifts the tombstone so a staff-recorded answer can occupy the slot.
   * Extraction still cannot undo a withdrawal; `audit_events` keeps the order.
   */
  async deleteAnswerWithdrawal(
    transaction: AppTransaction,
    slot: FeedbackAnswerSlot,
  ): Promise<FeedbackAnswerWithdrawalRow | undefined> {
    const [record] = await transaction
      .delete(feedbackAnswerWithdrawals)
      .where(withdrawalSlot(slot))
      .returning();

    return record;
  }

  /**
   * Staff-recorded answer. Plain insert behind the conversation lock; caller
   * lifts any tombstone. Empty citations are allowed only for `origin: staff`.
   * No `matchingHold` — that is a finding about testimony.
   */
  async insertStaffAnswer(
    transaction: AppTransaction,
    input: {
      readonly campaignId: string;
      readonly conversationId: string;
      readonly respondentParticipantId: string;
      readonly subjectParticipantId: string | null;
      readonly questionKey: FeedbackAnswerQuestionKey;
      readonly valueInt?: number | null;
      readonly extractionMeta: FeedbackExtractionMeta;
    },
  ): Promise<FeedbackAnswerRow | undefined> {
    const [record] = await transaction
      .insert(feedbackAnswers)
      .values({
        campaignId: input.campaignId,
        conversationId: input.conversationId,
        respondentParticipantId: input.respondentParticipantId,
        subjectParticipantId: input.subjectParticipantId,
        questionKey: input.questionKey,
        valueInt: input.valueInt ?? null,
        sourceMessageIds: [],
        extractionMeta: input.extractionMeta,
        matchingHold: false,
      })
      .returning();

    return record;
  }

  /** The tombstone on one answer slot, if a human has emptied it. */
  async findAnswerWithdrawal(
    executor: DatabaseExecutor,
    slot: FeedbackAnswerSlot,
  ): Promise<FeedbackAnswerWithdrawalRow | undefined> {
    const [record] = await executor
      .select()
      .from(feedbackAnswerWithdrawals)
      .where(withdrawalSlot(slot))
      .limit(1);

    return record;
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

  async findNoteById(
    id: string,
    executor: DatabaseExecutor = this.database.db,
  ): Promise<FeedbackNoteRow | undefined> {
    const [record] = await executor
      .select()
      .from(feedbackNotes)
      .where(eq(feedbackNotes.id, id))
      .limit(1);

    return record;
  }

  /**
   * Campaign-wide answers for the admin Results tab. Optional filters cover
   * question key and a participant appearing as respondent or subject.
   */
  async listAnswersByCampaign(
    campaignId: string,
    filters: {
      readonly questionKey?: string;
      readonly participantId?: string;
    } = {},
    executor: DatabaseExecutor = this.database.db,
  ): Promise<FeedbackAnswerRow[]> {
    const conditions = [eq(feedbackAnswers.campaignId, campaignId)];
    if (filters.questionKey) {
      conditions.push(eq(feedbackAnswers.questionKey, filters.questionKey));
    }
    if (filters.participantId) {
      conditions.push(
        or(
          eq(feedbackAnswers.respondentParticipantId, filters.participantId),
          eq(feedbackAnswers.subjectParticipantId, filters.participantId),
        )!,
      );
    }

    return executor
      .select()
      .from(feedbackAnswers)
      .where(and(...conditions))
      .orderBy(asc(feedbackAnswers.createdAt), asc(feedbackAnswers.id));
  }

  /**
   * Campaign-wide notes for the admin Results tab. Optional filters cover
   * review status and a participant appearing as respondent or subject.
   */
  async listNotesByCampaign(
    campaignId: string,
    filters: {
      readonly participantId?: string;
      readonly reviewStatus?: FeedbackNoteStatus;
    } = {},
    executor: DatabaseExecutor = this.database.db,
  ): Promise<FeedbackNoteRow[]> {
    const conditions = [eq(feedbackNotes.campaignId, campaignId)];
    if (filters.reviewStatus) {
      conditions.push(eq(feedbackNotes.status, filters.reviewStatus));
    }
    if (filters.participantId) {
      conditions.push(
        or(
          eq(feedbackNotes.respondentParticipantId, filters.participantId),
          eq(feedbackNotes.subjectParticipantId, filters.participantId),
        )!,
      );
    }

    return executor
      .select()
      .from(feedbackNotes)
      .where(and(...conditions))
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
