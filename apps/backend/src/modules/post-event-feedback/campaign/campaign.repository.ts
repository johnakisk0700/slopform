import { Injectable } from "@nestjs/common";
import {
  feedbackCampaigns,
  eventAttendees,
  events,
  participants,
  type AppTransaction,
  type FeedbackCampaignQuestions,
  type FeedbackCampaignRow,
  type FeedbackCampaignStatus,
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
}
