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

export const EVENT_VENUE_PROVIDERS = ["google"] as const;
export const EVENT_VENUE_PRICE_LEVELS = [
  "free",
  "inexpensive",
  "moderate",
  "expensive",
  "very_expensive",
] as const;

export type EventVenueProvider = (typeof EVENT_VENUE_PROVIDERS)[number];
export type EventVenuePriceLevel = (typeof EVENT_VENUE_PRICE_LEVELS)[number];

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
    venueProvider: text("venue_provider"),
    venuePlaceId: text("venue_place_id"),
    venueLabel: text("venue_label"),
    venueType: text("venue_type"),
    venueArea: text("venue_area"),
    venuePriceLevel: text("venue_price_level"),
    venuePriceStartMinor: integer("venue_price_start_minor"),
    venuePriceEndMinor: integer("venue_price_end_minor"),
    venuePriceCurrencyCode: text("venue_price_currency_code"),
    venueUseInFeedback: boolean("venue_use_in_feedback"),
    venueContextRevision: integer("venue_context_revision")
      .default(0)
      .notNull(),
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
    check(
      "events_venue_shape_check",
      sql`(
        ${table.venueProvider} is null and
        ${table.venuePlaceId} is null and
        ${table.venueLabel} is null and
        ${table.venueType} is null and
        ${table.venueArea} is null and
        ${table.venuePriceLevel} is null and
        ${table.venuePriceStartMinor} is null and
        ${table.venuePriceEndMinor} is null and
        ${table.venuePriceCurrencyCode} is null and
        ${table.venueUseInFeedback} is null
      ) or (
        ${table.venueProvider} is not null and
        ${table.venueProvider} = 'google' and
        ${table.venuePlaceId} is not null and
        ${table.venueLabel} is not null and
        ${table.venueUseInFeedback} is not null and
        ${table.venueContextRevision} >= 1
      )`,
    ),
    check(
      "events_venue_place_id_nonempty_check",
      sql`${table.venuePlaceId} is null or ${table.venuePlaceId} ~ '[^[:space:]]'`,
    ),
    check(
      "events_venue_label_length_check",
      sql`${table.venueLabel} is null or char_length(regexp_replace(${table.venueLabel}, '^[[:space:]]+|[[:space:]]+$', '', 'g')) between 1 and 200`,
    ),
    check(
      "events_venue_type_length_check",
      sql`${table.venueType} is null or char_length(regexp_replace(${table.venueType}, '^[[:space:]]+|[[:space:]]+$', '', 'g')) between 1 and 100`,
    ),
    check(
      "events_venue_area_length_check",
      sql`${table.venueArea} is null or char_length(regexp_replace(${table.venueArea}, '^[[:space:]]+|[[:space:]]+$', '', 'g')) between 1 and 200`,
    ),
    check(
      "events_venue_price_level_check",
      sql`${table.venuePriceLevel} is null or ${table.venuePriceLevel} in ('free', 'inexpensive', 'moderate', 'expensive', 'very_expensive')`,
    ),
    check(
      "events_venue_price_range_check",
      sql`(
        ${table.venuePriceStartMinor} is null and
        ${table.venuePriceEndMinor} is null and
        ${table.venuePriceCurrencyCode} is null
      ) or (
        ${table.venuePriceStartMinor} is not null and
        ${table.venuePriceStartMinor} >= 0 and
        (${table.venuePriceEndMinor} is null or ${table.venuePriceEndMinor} >= ${table.venuePriceStartMinor}) and
        ${table.venuePriceCurrencyCode} is not null and
        ${table.venuePriceCurrencyCode} ~ '^[A-Z]{3}$'
      )`,
    ),
    check(
      "events_venue_context_revision_check",
      sql`${table.venueContextRevision} >= 0`,
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

export type EventRow = typeof events.$inferSelect;
export type EventAttendeeRow = typeof eventAttendees.$inferSelect;
