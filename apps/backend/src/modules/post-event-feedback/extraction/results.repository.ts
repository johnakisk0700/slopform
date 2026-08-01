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
} from "@join-the-six/database";
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
   * Removes answers about one person that the answer just written contradicts.
   *
   * The uniqueness key is per (conversation, question, subject), so moving
   * somebody from `liked` to `avoid` writes a second row and keeps the first:
   * staff then read that the participant both liked Κώστας and asked never to
   * meet him again, with nothing to break the tie. Only the participant's
   * newest position is true, and this is what makes it the only one on file.
   *
   * A row a human corrected is left alone. This is the one place in the module
   * that hard-deletes an answer the model did not write, and the delete is
   * driven by the model: a later run accepting `avoid` for somebody would
   * otherwise erase an operator's corrected `liked` row with no trace on the
   * row at all. Freezing means the model may stop agreeing with a human, not
   * that it may delete them.
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
    // The second half of the withdrawal freeze, and the reason the tombstone
    // table exists. A withdrawal is a hard delete, so without this a later run
    // citing new testimony about the same question and subject inserts the
    // answer straight back and the operator's decision is undone with nothing
    // anywhere saying it happened. Read here rather than guarded in SQL because
    // the row being frozen does not exist to carry a predicate; safe against a
    // withdrawal landing mid-run because both paths hold the conversation
    // advisory lock for the whole transaction.
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
      // People change their minds — «βασικά 2, το ξανασκέφτηκα» — and an answer
      // that cannot be revised turned that into silence: the second value was
      // dropped, the bot said it had noted the change, and staff read the first
      // one forever. The newest reading of a question wins, which is what the
      // participant means by saying it again.
      //
      // Replay-safe: the same run rewrites the same values, and two runs on one
      // conversation are serialized by the advisory lock while the extraction
      // cursor stops an older run from re-reading messages a newer one has
      // already closed. So "newest write" and "newest testimony" agree.
      //
      // Two things the update is not allowed to do. It may not overwrite a row
      // an operator corrected — `setWhere` skips those, so the conflicting
      // insert writes nothing and the correction stands even if a run built its
      // context before the correction landed. And it may not drop the
      // `corrections` array while updating a row that is *not* frozen, so the
      // new provenance is merged over the old blob with that key carried
      // across; replacing `extraction_meta` wholesale would leave the audit
      // table as the only record that a human had ever touched the row.
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
          // Sticky, in the direction that cannot lose the hold: once a run has
          // found the respondent abusing the person an answer is about, a later
          // burst restating the same answer in polite words does not make it
          // honourable. `false or true` and `true or false` both stay held, and
          // only a migration could ever clear one.
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
   * An operator's correction to a recorded value.
   *
   * The row is edited in place; `extractionMeta` is supplied by the caller with
   * the correction already appended, so `model`, `confidence` and
   * `candidateIds` from the run that proposed the value survive on the row.
   * `sourceMessageIds` is untouched: the correction reads the same testimony
   * differently, and rewriting the citation would claim evidence that does not
   * exist.
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
   * Withdraws one answer entirely.
   *
   * A hard delete, as `deleteContradictedAnswers` already is: a soft-deleted row
   * would still occupy the `NULLS NOT DISTINCT` uniqueness key and would have to
   * be filtered out of every read of this table, where one omission puts a claim
   * an operator retracted back in front of staff. The whole row goes into the
   * audit context before it goes, which is where a withdrawal is answerable.
   *
   * The caller records a tombstone in the same transaction
   * (`recordAnswerWithdrawal`). Without it the delete says nothing about being
   * deliberate and a later run simply writes the answer back.
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
   * Marks one answer slot as decided-empty by a human.
   *
   * `onConflictDoNothing` on the slot key rather than an error: two operators
   * withdrawing the same answer a second apart are one decision, and the second
   * request has nothing to add. The first tombstone is the one that names who
   * decided, and re-withdrawing is impossible anyway once the row is gone.
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
   * Lifts the tombstone off one slot, for the one caller allowed to: an
   * operator recording an answer of their own there.
   *
   * The freeze exists so a later extraction run cannot quietly undo a human
   * decision. It was never meant to stop the human from changing their mind, and
   * leaving the tombstone in place would do exactly that — the `+` on the slot
   * somebody had just cleared would refuse forever, with the reason invisible.
   * The withdrawal is still on file in `audit_events`, followed by the
   * `feedback_answer.staff_recorded` event that replaced it, so the order of the
   * two decisions is recoverable in the only place that keeps decisions.
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
   * An answer an operator recorded by hand.
   *
   * A plain insert, unlike `insertAnswerIfAbsent`: there is no conflict to
   * resolve because the caller has already read the slot behind the conversation
   * lock and refuses when it is taken, and no tombstone to consult because the
   * caller lifts it. `sourceMessageIds` is empty — nothing was said, an operator
   * knew it — and the table permits that for `origin: staff` alone.
   *
   * `matchingHold` is deliberately not a parameter. The hold means "an
   * extraction run found the respondent abusing the person this row is about",
   * which is a finding about testimony; a row with no testimony behind it cannot
   * carry one.
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
