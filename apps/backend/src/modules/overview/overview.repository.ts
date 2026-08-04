import { Injectable } from "@nestjs/common";
import {
  EVENT_STATUSES,
  FEEDBACK_CAMPAIGN_STATUSES,
  eventAttendees,
  events,
  feedbackCampaignSummaries,
  feedbackCampaigns,
  participants,
  type EventStatus,
  type FeedbackCampaignStatus,
} from "@join-the-six/database";
import { and, asc, count, eq, isNull, sql } from "drizzle-orm";

import { DatabaseService } from "../../infrastructure/database/database.service.js";
import type {
  OverviewEventsView,
  OverviewParticipantsView,
  OverviewSummariesView,
} from "./overview.schemas.js";

type EventStatusCounts = OverviewEventsView["byStatus"];
type CampaignStatusCounts = {
  launched: number;
  paused: number;
  closed: number;
};

@Injectable()
export class OverviewRepository {
  constructor(private readonly database: DatabaseService) {}

  async loadEventsSnapshot(): Promise<OverviewEventsView> {
    const [statusRows, attendanceRows, unfinishedRows, nextScheduledRows] =
      await Promise.all([
        this.database.db
          .select({
            status: events.status,
            total: count(),
          })
          .from(events)
          .groupBy(events.status),
        this.database.db
          .select({
            attendeeCount: count(eventAttendees.id),
            presentCount: sql<number>`coalesce(sum(case when ${eventAttendees.present} then 1 else 0 end), 0)::int`,
          })
          .from(eventAttendees),
        this.database.db
          .select({ total: count() })
          .from(events)
          .leftJoin(feedbackCampaigns, eq(feedbackCampaigns.eventId, events.id))
          .where(
            and(eq(events.status, "finished"), isNull(feedbackCampaigns.id)),
          ),
        this.database.db
          .select({
            id: events.id,
            title: events.title,
            startsAt: events.startsAt,
            venueLabel: events.venueLabel,
            attendeeCount: count(eventAttendees.id),
          })
          .from(events)
          .leftJoin(eventAttendees, eq(eventAttendees.eventId, events.id))
          .where(eq(events.status, "scheduled"))
          .groupBy(events.id)
          .orderBy(asc(events.startsAt), asc(events.createdAt))
          .limit(1),
      ]);

    const byStatus = zeroEventStatusCounts();
    let total = 0;
    for (const row of statusRows) {
      const status = EVENT_STATUSES.find(
        (candidate) => candidate === row.status,
      );
      if (!status) continue;
      const value = Number(row.total);
      byStatus[status] = value;
      total += value;
    }

    const attendance = attendanceRows[0];
    const next = nextScheduledRows[0];

    return {
      total,
      byStatus,
      attendeeCount: Number(attendance?.attendeeCount ?? 0),
      presentCount: Number(attendance?.presentCount ?? 0),
      finishedWithoutFeedbackCampaignCount: Number(
        unfinishedRows[0]?.total ?? 0,
      ),
      nextScheduled: next
        ? {
            id: next.id,
            title: next.title,
            startsAt: next.startsAt.toISOString(),
            attendeeCount: Number(next.attendeeCount),
            venueLabel: next.venueLabel,
          }
        : null,
    };
  }

  async loadParticipantsSnapshot(): Promise<OverviewParticipantsView> {
    const [row] = await this.database.db
      .select({
        total: count(),
        whatsappFeedbackOptInCount: sql<number>`coalesce(sum(case when ${participants.postEventFeedbackWhatsappOptIn} then 1 else 0 end), 0)::int`,
        withPhoneCount: sql<number>`coalesce(sum(case when ${participants.phoneE164} is not null then 1 else 0 end), 0)::int`,
        feedbackContactableCount: sql<number>`coalesce(sum(case when ${participants.postEventFeedbackWhatsappOptIn} and ${participants.phoneE164} is not null then 1 else 0 end), 0)::int`,
      })
      .from(participants);

    return {
      total: Number(row?.total ?? 0),
      whatsappFeedbackOptInCount: Number(row?.whatsappFeedbackOptInCount ?? 0),
      withPhoneCount: Number(row?.withPhoneCount ?? 0),
      feedbackContactableCount: Number(row?.feedbackContactableCount ?? 0),
    };
  }

  async loadCampaignStatusCounts(): Promise<{
    total: number;
    byStatus: CampaignStatusCounts;
  }> {
    const rows = await this.database.db
      .select({
        status: feedbackCampaigns.status,
        total: count(),
      })
      .from(feedbackCampaigns)
      .groupBy(feedbackCampaigns.status);

    const byStatus = zeroCampaignStatusCounts();
    let total = 0;
    for (const row of rows) {
      const status = FEEDBACK_CAMPAIGN_STATUSES.find(
        (candidate) => candidate === row.status,
      );
      if (!status) continue;
      const value = Number(row.total);
      byStatus[status] = value;
      total += value;
    }
    return { total, byStatus };
  }

  async loadSummaryCounts(): Promise<OverviewSummariesView> {
    const [row] = await this.database.db
      .select({
        none: sql<number>`coalesce(sum(case when ${feedbackCampaignSummaries.id} is null then 1 else 0 end), 0)::int`,
        pending: sql<number>`coalesce(sum(case when ${feedbackCampaignSummaries.status} = 'pending' then 1 else 0 end), 0)::int`,
        ready: sql<number>`coalesce(sum(case when ${feedbackCampaignSummaries.status} = 'ready' then 1 else 0 end), 0)::int`,
        failed: sql<number>`coalesce(sum(case when ${feedbackCampaignSummaries.status} = 'failed' then 1 else 0 end), 0)::int`,
      })
      .from(feedbackCampaigns)
      .leftJoin(
        feedbackCampaignSummaries,
        eq(feedbackCampaignSummaries.campaignId, feedbackCampaigns.id),
      );

    return {
      none: Number(row?.none ?? 0),
      pending: Number(row?.pending ?? 0),
      ready: Number(row?.ready ?? 0),
      failed: Number(row?.failed ?? 0),
    };
  }
}

function zeroEventStatusCounts(): EventStatusCounts {
  return {
    draft: 0,
    scheduled: 0,
    finished: 0,
    cancelled: 0,
  } satisfies Record<EventStatus, number>;
}

function zeroCampaignStatusCounts(): CampaignStatusCounts {
  return {
    launched: 0,
    paused: 0,
    closed: 0,
  } satisfies Record<FeedbackCampaignStatus, number>;
}
