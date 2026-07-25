import { Injectable } from "@nestjs/common";
import {
  eventAttendees,
  events,
  participants,
  type AppTransaction,
  type EventAttendeeRow,
  type EventRow,
  type EventStatus,
} from "@join-the-six/database";
import { and, asc, count, eq, sql } from "drizzle-orm";

import { DatabaseService } from "../../infrastructure/database/database.service.js";

export interface EventSummaryRow extends EventRow {
  readonly attendeeCount: number;
  readonly presentCount: number;
}

export interface EventAttendeeJoinedRow extends EventAttendeeRow {
  readonly preferredName: string | null;
  readonly emailNormalized: string;
}

export interface FeedbackCandidateRow {
  readonly participantId: string;
  readonly displayName: string;
  readonly present: boolean;
}

@Injectable()
export class EventsRepository {
  constructor(private readonly database: DatabaseService) {}

  async create(
    transaction: AppTransaction,
    input: { readonly title: string; readonly startsAt: Date },
  ): Promise<EventRow> {
    const [record] = await transaction
      .insert(events)
      .values({
        title: input.title,
        startsAt: input.startsAt,
        status: "draft",
      })
      .returning();

    if (!record) {
      throw new Error("Event insert returned no row");
    }

    return record;
  }

  async update(
    transaction: AppTransaction,
    id: string,
    input: { readonly title?: string; readonly startsAt?: Date },
  ): Promise<EventRow | undefined> {
    const [record] = await transaction
      .update(events)
      .set({
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.startsAt !== undefined ? { startsAt: input.startsAt } : {}),
        updatedAt: new Date(),
      })
      .where(eq(events.id, id))
      .returning();

    return record;
  }

  async transitionStatus(
    transaction: AppTransaction,
    id: string,
    status: EventStatus,
  ): Promise<EventRow | undefined> {
    const [record] = await transaction
      .update(events)
      .set({ status, updatedAt: new Date() })
      .where(eq(events.id, id))
      .returning();

    return record;
  }

  async findById(id: string): Promise<EventRow | undefined> {
    const [record] = await this.database.db
      .select()
      .from(events)
      .where(eq(events.id, id))
      .limit(1);

    return record;
  }

  async findByIdForUpdate(
    transaction: AppTransaction,
    id: string,
  ): Promise<EventRow | undefined> {
    const [record] = await transaction
      .select()
      .from(events)
      .where(eq(events.id, id))
      .limit(1)
      .for("update");

    return record;
  }

  async listSummaries(): Promise<EventSummaryRow[]> {
    const rows = await this.database.db
      .select({
        id: events.id,
        title: events.title,
        startsAt: events.startsAt,
        status: events.status,
        createdAt: events.createdAt,
        updatedAt: events.updatedAt,
        attendeeCount: count(eventAttendees.id),
        presentCount: sql<number>`coalesce(sum(case when ${eventAttendees.present} then 1 else 0 end), 0)::int`,
      })
      .from(events)
      .leftJoin(eventAttendees, eq(eventAttendees.eventId, events.id))
      .groupBy(events.id)
      .orderBy(asc(events.startsAt), asc(events.createdAt));

    return rows.map((row) => ({
      ...row,
      status: row.status as EventStatus,
      attendeeCount: Number(row.attendeeCount),
      presentCount: Number(row.presentCount),
    }));
  }

  async summarize(id: string): Promise<EventSummaryRow | undefined> {
    const [row] = await this.database.db
      .select({
        id: events.id,
        title: events.title,
        startsAt: events.startsAt,
        status: events.status,
        createdAt: events.createdAt,
        updatedAt: events.updatedAt,
        attendeeCount: count(eventAttendees.id),
        presentCount: sql<number>`coalesce(sum(case when ${eventAttendees.present} then 1 else 0 end), 0)::int`,
      })
      .from(events)
      .leftJoin(eventAttendees, eq(eventAttendees.eventId, events.id))
      .where(eq(events.id, id))
      .groupBy(events.id)
      .limit(1);

    if (!row) {
      return undefined;
    }

    return {
      ...row,
      status: row.status as EventStatus,
      attendeeCount: Number(row.attendeeCount),
      presentCount: Number(row.presentCount),
    };
  }

  async listAttendees(eventId: string): Promise<EventAttendeeJoinedRow[]> {
    return this.database.db
      .select({
        id: eventAttendees.id,
        eventId: eventAttendees.eventId,
        participantId: eventAttendees.participantId,
        tableNo: eventAttendees.tableNo,
        present: eventAttendees.present,
        createdAt: eventAttendees.createdAt,
        updatedAt: eventAttendees.updatedAt,
        preferredName: participants.preferredName,
        emailNormalized: participants.emailNormalized,
      })
      .from(eventAttendees)
      .innerJoin(
        participants,
        eq(participants.id, eventAttendees.participantId),
      )
      .where(eq(eventAttendees.eventId, eventId))
      .orderBy(
        asc(eventAttendees.tableNo),
        asc(participants.preferredName),
        asc(participants.emailNormalized),
      );
  }

  async findAttendeeById(
    eventId: string,
    attendeeId: string,
  ): Promise<EventAttendeeJoinedRow | undefined> {
    const [row] = await this.database.db
      .select({
        id: eventAttendees.id,
        eventId: eventAttendees.eventId,
        participantId: eventAttendees.participantId,
        tableNo: eventAttendees.tableNo,
        present: eventAttendees.present,
        createdAt: eventAttendees.createdAt,
        updatedAt: eventAttendees.updatedAt,
        preferredName: participants.preferredName,
        emailNormalized: participants.emailNormalized,
      })
      .from(eventAttendees)
      .innerJoin(
        participants,
        eq(participants.id, eventAttendees.participantId),
      )
      .where(
        and(
          eq(eventAttendees.eventId, eventId),
          eq(eventAttendees.id, attendeeId),
        ),
      )
      .limit(1);

    return row;
  }

  async findAttendeeByParticipant(
    transaction: AppTransaction,
    eventId: string,
    participantId: string,
  ): Promise<EventAttendeeRow | undefined> {
    const [row] = await transaction
      .select()
      .from(eventAttendees)
      .where(
        and(
          eq(eventAttendees.eventId, eventId),
          eq(eventAttendees.participantId, participantId),
        ),
      )
      .limit(1);

    return row;
  }

  async insertAttendee(
    transaction: AppTransaction,
    input: {
      readonly eventId: string;
      readonly participantId: string;
      readonly tableNo: number | null;
      readonly present: boolean;
    },
  ): Promise<EventAttendeeRow> {
    const [record] = await transaction
      .insert(eventAttendees)
      .values({
        eventId: input.eventId,
        participantId: input.participantId,
        tableNo: input.tableNo,
        present: input.present,
      })
      .returning();

    if (!record) {
      throw new Error("Event attendee insert returned no row");
    }

    return record;
  }

  async updateAttendee(
    transaction: AppTransaction,
    eventId: string,
    attendeeId: string,
    input: {
      readonly tableNo?: number | null;
      readonly present?: boolean;
    },
  ): Promise<EventAttendeeRow | undefined> {
    const [record] = await transaction
      .update(eventAttendees)
      .set({
        ...(input.tableNo !== undefined ? { tableNo: input.tableNo } : {}),
        ...(input.present !== undefined ? { present: input.present } : {}),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(eventAttendees.eventId, eventId),
          eq(eventAttendees.id, attendeeId),
        ),
      )
      .returning();

    return record;
  }

  async participantExists(
    transaction: AppTransaction,
    participantId: string,
  ): Promise<boolean> {
    const [row] = await transaction
      .select({ id: participants.id })
      .from(participants)
      .where(eq(participants.id, participantId))
      .limit(1);

    return Boolean(row);
  }

  /**
   * Loads present attendees for an event with display names. Callers must apply
   * {@link selectFeedbackCandidates} / the D16 helper rather than filtering ad hoc.
   */
  async listPresentAttendeeCandidates(
    eventId: string,
  ): Promise<FeedbackCandidateRow[]> {
    const rows = await this.database.db
      .select({
        participantId: eventAttendees.participantId,
        preferredName: participants.preferredName,
        emailNormalized: participants.emailNormalized,
        present: eventAttendees.present,
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
        ),
      )
      .orderBy(
        asc(participants.preferredName),
        asc(participants.emailNormalized),
      );

    return rows.map((row) => ({
      participantId: row.participantId,
      displayName: row.preferredName?.trim() || row.emailNormalized,
      present: row.present,
    }));
  }
}
