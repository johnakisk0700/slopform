import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { participants } from "./participants.js";

export const EVENT_STATUSES = [
  "draft",
  "scheduled",
  "finished",
  "cancelled",
] as const;

export type EventStatus = (typeof EVENT_STATUSES)[number];

export const events = pgTable(
  "events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    title: text("title").notNull(),
    startsAt: timestamp("starts_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    status: text("status").notNull().default("draft"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    check(
      "events_title_length_check",
      sql`char_length(btrim(${table.title})) between 1 and 200`,
    ),
    check(
      "events_status_check",
      sql`${table.status} in ('draft', 'scheduled', 'finished', 'cancelled')`,
    ),
    index("events_status_starts_at_idx").on(table.status, table.startsAt),
  ],
);

export const eventAttendees = pgTable(
  "event_attendees",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    eventId: uuid("event_id").notNull(),
    participantId: uuid("participant_id").notNull(),
    tableNo: integer("table_no"),
    present: boolean("present").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.eventId],
      foreignColumns: [events.id],
      name: "event_attendees_event_id_events_id_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.participantId],
      foreignColumns: [participants.id],
      name: "event_attendees_participant_id_participants_id_fk",
    }).onDelete("restrict"),
    check(
      "event_attendees_table_no_check",
      sql`${table.tableNo} is null or ${table.tableNo} between 1 and 999`,
    ),
    uniqueIndex("event_attendees_event_participant_uidx").on(
      table.eventId,
      table.participantId,
    ),
    index("event_attendees_event_present_idx").on(table.eventId, table.present),
    index("event_attendees_participant_idx").on(table.participantId),
  ],
);

export type EventInsert = typeof events.$inferInsert;
export type EventRow = typeof events.$inferSelect;
export type EventAttendeeInsert = typeof eventAttendees.$inferInsert;
export type EventAttendeeRow = typeof eventAttendees.$inferSelect;
