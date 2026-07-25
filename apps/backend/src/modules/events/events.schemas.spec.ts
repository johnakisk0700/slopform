import { describe, expect, it } from "vitest";

import {
  EVENT_STATUS_TRANSITIONS,
  createEventSchema,
  updateEventAttendeeSchema,
} from "./events.schemas.js";

describe("events schemas", () => {
  it("encodes the draft→scheduled→finished|cancelled graph", () => {
    expect(EVENT_STATUS_TRANSITIONS.draft).toEqual(["scheduled", "cancelled"]);
    expect(EVENT_STATUS_TRANSITIONS.scheduled).toEqual([
      "finished",
      "cancelled",
    ]);
    expect(EVENT_STATUS_TRANSITIONS.finished).toEqual([]);
    expect(EVENT_STATUS_TRANSITIONS.cancelled).toEqual([]);
  });

  it("requires a title and start time on create", () => {
    expect(
      createEventSchema.safeParse({
        title: "Dinner",
        startsAt: "2026-08-01T18:00:00.000Z",
      }).success,
    ).toBe(true);
    expect(createEventSchema.safeParse({ title: "Dinner" }).success).toBe(
      false,
    );
  });

  it("requires at least one attendance correction field", () => {
    expect(updateEventAttendeeSchema.safeParse({}).success).toBe(false);
    expect(
      updateEventAttendeeSchema.safeParse({ present: false }).success,
    ).toBe(true);
  });
});
