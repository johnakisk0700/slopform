import { Injectable } from "@nestjs/common";
import {
  feedbackAnswers,
  feedbackNotes,
  type AppTransaction,
  type FeedbackAnswerQuestionKey,
  type FeedbackAnswerRow,
  type FeedbackExtractionMeta,
  type FeedbackNoteRow,
  type FeedbackNoteStatus,
  type FeedbackNoteType,
} from "@join-the-six/database";
import { and, asc, eq, inArray, or, sql } from "drizzle-orm";

import { DatabaseService } from "../../../infrastructure/database/database.service.js";

type DatabaseExecutor = AppTransaction | DatabaseService["db"];

@Injectable()
export class FeedbackResultsRepository {
  constructor(private readonly database: DatabaseService) {}

  /**
   * Inserts a directed answer. Conflicts on the NULLS NOT DISTINCT uniqueness
   * key are ignored so extraction replay stays idempotent.
   */
  /**
   * Removes answers about one person that the answer just written contradicts.
   *
   * The uniqueness key is per (conversation, question, subject), so moving
   * somebody from `liked` to `avoid` writes a second row and keeps the first:
   * staff then read that the participant both liked Κώστας and asked never to
   * meet him again, with nothing to break the tie. Only the participant's
   * newest position is true, and this is what makes it the only one on file.
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
      .onConflictDoUpdate({
        target: [
          feedbackAnswers.conversationId,
          feedbackAnswers.questionKey,
          feedbackAnswers.subjectParticipantId,
        ],
        set: {
          valueInt: input.valueInt ?? null,
          sourceMessageIds: [...input.sourceMessageIds],
          extractionMeta: input.extractionMeta,
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
