import { readFileSync } from "node:fs";

import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { eventAttendees, events } from "./events.js";
import { participants } from "./participants.js";

const dialect = new PgDialect();

describe("events and event_attendees database constraints", () => {
  it("allowlists event statuses and bounds titles", () => {
    const config = getTableConfig(events);
    const checks = new Map(
      config.checks.map((check) => [
        check.name,
        dialect.sqlToQuery(check.value).sql,
      ]),
    );

    expect(checks.get("events_status_check")).toContain(
      "'draft', 'scheduled', 'finished', 'cancelled'",
    );
    expect(checks.get("events_title_length_check")).toContain(
      "between 1 and 200",
    );
  });

  it("keeps venue snapshots coherent and their revision monotonic", () => {
    const config = getTableConfig(events);
    const columns = new Map(
      config.columns.map((column) => [column.name, column]),
    );
    const checks = new Map(
      config.checks.map((check) => [
        check.name,
        dialect.sqlToQuery(check.value).sql,
      ]),
    );

    expect(columns.get("venue_context_revision")?.notNull).toBe(true);
    expect(columns.get("venue_context_revision")?.hasDefault).toBe(true);
    expect(checks.get("events_venue_shape_check")).toContain(
      '"events"."venue_provider" is not null',
    );
    expect(checks.get("events_venue_shape_check")).toContain(
      '"events"."venue_provider" = \'google\'',
    );
    expect(checks.get("events_venue_shape_check")).toContain(
      '"events"."venue_context_revision" >= 1',
    );
    expect(checks.get("events_venue_place_id_nonempty_check")).toContain(
      "[^[:space:]]",
    );
    expect(checks.get("events_venue_place_id_nonempty_check")).not.toContain(
      "255",
    );
    expect(checks.get("events_venue_price_level_check")).toContain(
      "'free', 'inexpensive', 'moderate', 'expensive', 'very_expensive'",
    );
    expect(checks.get("events_venue_label_length_check")).toContain(
      "regexp_replace",
    );
    expect(checks.get("events_venue_price_range_check")).toContain(
      "^[A-Z]{3}$",
    );
    expect(checks.get("events_venue_context_revision_check")).toContain(">= 0");
  });

  it("uniquely scopes attendees per event and restricts participant deletes", () => {
    const config = getTableConfig(eventAttendees);
    const indexes = new Map(
      config.indexes.map((index) => [index.config.name, index]),
    );
    const uniqueIndex = indexes.get("event_attendees_event_participant_uidx");
    const participantFk = config.foreignKeys.find((fk) =>
      fk.getName().includes("participant_id"),
    );

    expect(uniqueIndex?.config.unique).toBe(true);
    expect(
      uniqueIndex?.config.columns.map((column) =>
        "name" in column ? column.name : undefined,
      ),
    ).toEqual(["event_id", "participant_id"]);
    expect(participantFk?.onDelete).toBe("restrict");
  });

  it("defaults feedback WhatsApp opt-in to false on participants", () => {
    const config = getTableConfig(participants);
    const column = config.columns.find(
      (entry) => entry.name === "post_event_feedback_whatsapp_opt_in",
    );

    expect(column?.notNull).toBe(true);
    expect(column?.hasDefault).toBe(true);
  });

  it("keeps the stub-events migration reversible-safe and free of feedback tables", () => {
    const migration = readFileSync(
      new URL(
        "../../drizzle/20260725180038_stub_events_and_feedback_opt_in.sql",
        import.meta.url,
      ),
      "utf8",
    );

    expect(migration).toContain('CREATE TABLE "events"');
    expect(migration).toContain('CREATE TABLE "event_attendees"');
    expect(migration).toContain(
      'ADD COLUMN "post_event_feedback_whatsapp_opt_in"',
    );
    expect(migration).toContain("ON DELETE restrict");
    expect(migration).not.toContain('CREATE TABLE "feedback_');
    expect(migration).not.toContain("feedback_campaigns");
    expect(migration).not.toContain("feedback_answers");
  });

  it("adds event venue context in place without creating a second venue authority", () => {
    const migration = readFileSync(
      new URL(
        "../../drizzle/20260802140631_event_venue_context.sql",
        import.meta.url,
      ),
      "utf8",
    );

    expect(migration).toContain(
      'ADD COLUMN "venue_context_revision" integer DEFAULT 0 NOT NULL',
    );
    expect(migration).toContain('CONSTRAINT "events_venue_shape_check" CHECK');
    expect(migration).toContain(
      'CONSTRAINT "events_venue_place_id_nonempty_check" CHECK',
    );
    expect(migration).not.toContain("255");
    expect(migration).not.toContain('CREATE TABLE "event_venues"');
    expect(migration).not.toContain('CREATE TABLE "venues"');
  });
});
