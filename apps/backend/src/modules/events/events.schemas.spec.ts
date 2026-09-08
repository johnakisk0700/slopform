import { describe, expect, it } from "vitest";

import {
  eventVenueInputSchema,
  updateEventAttendeeSchema,
  updateEventSchema,
} from "./events.schemas.js";

const venue = {
  provider: "google" as const,
  placeId: "ChIJN1t_tDeuEmsRUsoyG83frY4",
  label: "Six Tables Athens",
  type: "restaurant",
  area: "Pangrati",
  priceLevel: "moderate" as const,
  priceRange: {
    startMinor: 1_800,
    endMinor: 2_600,
    currencyCode: "EUR",
  },
  useInFeedback: true,
};

describe("events schemas", () => {
  it("does not invent a maximum length for Google Place IDs", () => {
    expect(
      eventVenueInputSchema.safeParse({
        provider: "google",
        placeId: `ChIJ${"x".repeat(1_000)}`,
        label: "Long-lived place",
        useInFeedback: false,
      }).success,
    ).toBe(true);
  });

  it("treats venue updates as whole-object replacement or explicit clear", () => {
    expect(updateEventSchema.safeParse({ venue }).success).toBe(true);
    expect(updateEventSchema.safeParse({ venue: null }).success).toBe(true);
    expect(updateEventSchema.safeParse({ venue: {} }).success).toBe(false);
    expect(updateEventSchema.safeParse({}).success).toBe(false);
  });

  it("keeps contextRevision server-owned", () => {
    expect(
      eventVenueInputSchema.safeParse({ ...venue, contextRevision: 4 }).success,
    ).toBe(false);
  });

  it("rejects invented price levels and malformed exact ranges", () => {
    expect(
      eventVenueInputSchema.safeParse({
        ...venue,
        priceLevel: "luxury",
      }).success,
    ).toBe(false);
    expect(
      eventVenueInputSchema.safeParse({
        ...venue,
        priceRange: {
          startMinor: 2_600,
          endMinor: 1_800,
          currencyCode: "EUR",
        },
      }).success,
    ).toBe(false);
    expect(
      eventVenueInputSchema.safeParse({
        ...venue,
        priceRange: { startMinor: 1_800, currencyCode: "eur" },
      }).success,
    ).toBe(false);
    expect(
      eventVenueInputSchema.safeParse({
        ...venue,
        priceRange: { startMinor: 1_800 },
      }).success,
    ).toBe(false);
  });

  it("requires at least one attendance correction field", () => {
    expect(updateEventAttendeeSchema.safeParse({}).success).toBe(false);
    expect(
      updateEventAttendeeSchema.safeParse({ present: false }).success,
    ).toBe(true);
  });
});
