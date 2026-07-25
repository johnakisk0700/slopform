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
});
