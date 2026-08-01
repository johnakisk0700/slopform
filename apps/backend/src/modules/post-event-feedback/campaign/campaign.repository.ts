import { Injectable } from "@nestjs/common";
import {
  feedbackCampaigns,
  feedbackCampaignSummaries,
  eventAttendees,
  events,
  participants,
  type AppTransaction,
  type FeedbackCampaignQuestions,
  type FeedbackCampaignRow,
  type FeedbackCampaignStatus,
  type FeedbackCampaignSummaryRow,
  type FeedbackCampaignSummaryTrigger,
} from "@join-the-six/database";
import { and, asc, desc, eq, isNotNull } from "drizzle-orm";

import { DatabaseService } from "../../../infrastructure/database/database.service.js";

export type FeedbackEligibleAttendee = {
  readonly participantId: string;
  readonly preferredName: string | null;
  readonly emailNormalized: string;
  readonly phoneE164: string;
};

export type FeedbackCampaignWithEventTitle = {
  readonly campaign: FeedbackCampaignRow;
  readonly eventTitle: string;
};

type DatabaseExecutor = AppTransaction | DatabaseService["db"];

@Injectable()
export class FeedbackCampaignRepository {
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

  /**
   * Staff campaign picker: newest launch first, with the event title joined
   * so the list does not need a second events round-trip.
   */
  async listCampaignsNewestFirst(
    executor: DatabaseExecutor = this.database.db,
    limit = 200,
  ): Promise<FeedbackCampaignWithEventTitle[]> {
    const boundedLimit = Math.min(Math.max(1, limit), 200);
    const rows = await executor
      .select({
        campaign: feedbackCampaigns,
        eventTitle: events.title,
      })
      .from(feedbackCampaigns)
      .innerJoin(events, eq(events.id, feedbackCampaigns.eventId))
      .orderBy(desc(feedbackCampaigns.launchedAt), desc(feedbackCampaigns.id))
      .limit(boundedLimit);

    return rows.map((row) => ({
      campaign: row.campaign,
      eventTitle: row.eventTitle,
    }));
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

  async findSummaryByCampaignId(
    campaignId: string,
    executor: DatabaseExecutor = this.database.db,
  ): Promise<FeedbackCampaignSummaryRow | undefined> {
    const [record] = await executor
      .select()
      .from(feedbackCampaignSummaries)
      .where(eq(feedbackCampaignSummaries.campaignId, campaignId))
      .limit(1);

    return record;
  }

  async upsertSummaryPending(
    transaction: AppTransaction,
    input: {
      readonly campaignId: string;
      readonly attempt: number;
      readonly isPartial: boolean;
      readonly trigger: FeedbackCampaignSummaryTrigger;
      readonly openConversationCount: number;
      readonly requestedAt: Date;
    },
  ): Promise<FeedbackCampaignSummaryRow> {
    const existing = await this.findSummaryByCampaignId(
      input.campaignId,
      transaction,
    );

    if (existing) {
      const [record] = await transaction
        .update(feedbackCampaignSummaries)
        .set({
          status: "pending",
          body: null,
          model: null,
          reasoningEffort: null,
          error: null,
          attempt: input.attempt,
          isPartial: input.isPartial,
          trigger: input.trigger,
          openConversationCount: input.openConversationCount,
          answerCount: 0,
          noteCount: 0,
          requestedAt: input.requestedAt,
          generatedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(feedbackCampaignSummaries.campaignId, input.campaignId))
        .returning();

      if (!record) {
        throw new Error("Feedback campaign summary update returned no row");
      }
      return record;
    }

    const [record] = await transaction
      .insert(feedbackCampaignSummaries)
      .values({
        campaignId: input.campaignId,
        status: "pending",
        attempt: input.attempt,
        isPartial: input.isPartial,
        trigger: input.trigger,
        openConversationCount: input.openConversationCount,
        requestedAt: input.requestedAt,
      })
      .returning();

    if (!record) {
      throw new Error("Feedback campaign summary insert returned no row");
    }
    return record;
  }

  async markSummaryReady(
    transaction: AppTransaction,
    input: {
      readonly campaignId: string;
      readonly attempt: number;
      readonly body: string;
      readonly model: string;
      readonly reasoningEffort: string;
      readonly answerCount: number;
      readonly noteCount: number;
      readonly generatedAt: Date;
    },
  ): Promise<FeedbackCampaignSummaryRow | undefined> {
    const [record] = await transaction
      .update(feedbackCampaignSummaries)
      .set({
        status: "ready",
        body: input.body,
        model: input.model,
        reasoningEffort: input.reasoningEffort,
        error: null,
        answerCount: input.answerCount,
        noteCount: input.noteCount,
        generatedAt: input.generatedAt,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(feedbackCampaignSummaries.campaignId, input.campaignId),
          eq(feedbackCampaignSummaries.attempt, input.attempt),
          eq(feedbackCampaignSummaries.status, "pending"),
        ),
      )
      .returning();

    return record;
  }

  async markSummaryFailed(
    transaction: AppTransaction,
    input: {
      readonly campaignId: string;
      readonly attempt: number;
      readonly error: string;
      readonly generatedAt: Date;
    },
  ): Promise<FeedbackCampaignSummaryRow | undefined> {
    const [record] = await transaction
      .update(feedbackCampaignSummaries)
      .set({
        status: "failed",
        error: input.error,
        generatedAt: input.generatedAt,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(feedbackCampaignSummaries.campaignId, input.campaignId),
          eq(feedbackCampaignSummaries.attempt, input.attempt),
          eq(feedbackCampaignSummaries.status, "pending"),
        ),
      )
      .returning();

    return record;
  }
}
