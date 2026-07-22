import { describe, expect, it } from "vitest";
import {
  eventPreviewSchema,
  getEventPreviewErrors,
} from "../app/features/event/schema";

describe("eventPreviewSchema", () => {
  it("normalizes a valid preview event draft", () => {
    const date = new Date("2026-08-06T00:00:00.000Z");

    expect(
      eventPreviewSchema.parse({ name: "  Foundation dinner  ", date }),
    ).toEqual({ name: "Foundation dinner", date });
  });

  it("returns one field-addressable error per invalid input", () => {
    const errors = getEventPreviewErrors({ name: "x", date: null });

    expect(errors).toEqual({
      name: "Use at least three characters.",
      date: "Choose a date.",
    });
  });
});
