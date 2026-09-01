import { Injectable } from "@nestjs/common";
import {
  eventAttendees,
  events,
  participants,
  type AppTransaction,
  type EventRow,
  type EventStatus,
  type ParticipantRow,
} from "@slopform/database";
import { asc, desc, eq, inArray } from "drizzle-orm";

import { DatabaseService } from "../../infrastructure/database/database.service.js";

export type ParticipantEventHistoryRow = Pick<
  EventRow,
  | "venueProvider"
  | "venuePlaceId"
  | "venueLabel"
  | "venueType"
  | "venueArea"
  | "venuePriceLevel"
  | "venuePriceStartMinor"
  | "venuePriceEndMinor"
  | "venuePriceCurrencyCode"
  | "venueUseInFeedback"
  | "venueContextRevision"
> & {
  eventId: string;
  title: string;
  startsAt: Date;
  status: EventStatus;
  present: boolean;
  tableNo: number | null;
};

@Injectable()
export class ParticipantsRepository {
  constructor(private readonly database: DatabaseService) {}

  async list(): Promise<ParticipantRow[]> {
    return this.database.db
      .select()
      .from(participants)
      .orderBy(
        asc(participants.preferredName),
        asc(participants.emailNormalized),
      )
      .limit(500);
  }

  async findById(id: string): Promise<ParticipantRow | undefined> {
    const [row] = await this.database.db
      .select()
      .from(participants)
      .where(eq(participants.id, id))
      .limit(1);

    return row;
  }

  async listEventsForParticipant(
    participantId: string,
  ): Promise<ParticipantEventHistoryRow[]> {
    const rows = await this.database.db
      .select({
        eventId: events.id,
        title: events.title,
        startsAt: events.startsAt,
        status: events.status,
        venueProvider: events.venueProvider,
        venuePlaceId: events.venuePlaceId,
        venueLabel: events.venueLabel,
        venueType: events.venueType,
        venueArea: events.venueArea,
        venuePriceLevel: events.venuePriceLevel,
        venuePriceStartMinor: events.venuePriceStartMinor,
        venuePriceEndMinor: events.venuePriceEndMinor,
        venuePriceCurrencyCode: events.venuePriceCurrencyCode,
        venueUseInFeedback: events.venueUseInFeedback,
        venueContextRevision: events.venueContextRevision,
        present: eventAttendees.present,
        tableNo: eventAttendees.tableNo,
      })
      .from(eventAttendees)
      .innerJoin(events, eq(events.id, eventAttendees.eventId))
      .where(eq(eventAttendees.participantId, participantId))
      .orderBy(desc(events.startsAt), desc(events.id))
      .limit(500);

    return rows.map((row) => ({
      eventId: row.eventId,
      title: row.title,
      startsAt: row.startsAt,
      status: row.status as EventStatus,
      venueProvider: row.venueProvider,
      venuePlaceId: row.venuePlaceId,
      venueLabel: row.venueLabel,
      venueType: row.venueType,
      venueArea: row.venueArea,
      venuePriceLevel: row.venuePriceLevel,
      venuePriceStartMinor: row.venuePriceStartMinor,
      venuePriceEndMinor: row.venuePriceEndMinor,
      venuePriceCurrencyCode: row.venuePriceCurrencyCode,
      venueUseInFeedback: row.venueUseInFeedback,
      venueContextRevision: row.venueContextRevision,
      present: row.present,
      tableNo: row.tableNo,
    }));
  }

  async findByIds(ids: readonly string[]): Promise<ParticipantRow[]> {
    if (ids.length === 0) {
      return [];
    }
    return this.database.db
      .select()
      .from(participants)
      .where(inArray(participants.id, [...ids]));
  }

  async findByIdForUpdate(
    transaction: AppTransaction,
    id: string,
  ): Promise<ParticipantRow | undefined> {
    const [row] = await transaction
      .select()
      .from(participants)
      .where(eq(participants.id, id))
      .limit(1)
      .for("update");

    return row;
  }

  async updateFeedbackOptIn(
    transaction: AppTransaction,
    id: string,
    postEventFeedbackWhatsappOptIn: boolean,
  ): Promise<ParticipantRow | undefined> {
    const [row] = await transaction
      .update(participants)
      .set({
        postEventFeedbackWhatsappOptIn,
        updatedAt: new Date(),
      })
      .where(eq(participants.id, id))
      .returning();

    return row;
  }
}
