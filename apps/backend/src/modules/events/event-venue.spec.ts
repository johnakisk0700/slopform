import { describe, expect, it } from "vitest";

import { toEventFeedbackVenueSnapshot } from "./event-venue.js";

const EMPTY_VENUE = {
  venueProvider: null,
  venuePlaceId: null,
  venueLabel: null,
  venueType: null,
  venueArea: null,
  venuePriceLevel: null,
  venuePriceStartMinor: null,
  venuePriceEndMinor: null,
  venuePriceCurrencyCode: null,
  venueUseInFeedback: null,
  venueContextRevision: 4,
} as const;

describe("toEventVenueView", () => {
  it("strips Google identity from enabled feedback context", () => {
    const snapshot = toEventFeedbackVenueSnapshot({
      ...EMPTY_VENUE,
      venueProvider: "google",
      venuePlaceId: "ChIJ-secret-provider-id",
      venueLabel: "Sushi Place",
      venueType: "Japanese restaurant",
      venueArea: "Athens centre",
      venuePriceStartMinor: 1_500,
      venuePriceEndMinor: 3_000,
      venuePriceCurrencyCode: "EUR",
      venueUseInFeedback: true,
      venueContextRevision: 5,
    });

    expect(snapshot).toEqual({
      contextRevision: 5,
      venue: {
        label: "Sushi Place",
        type: "Japanese restaurant",
        area: "Athens centre",
        priceRange: {
          startMinor: 1_500,
          endMinor: 3_000,
          currencyCode: "EUR",
        },
      },
    });
    expect(JSON.stringify(snapshot)).not.toContain("ChIJ");
  });

  it("returns no feedback context when staff disabled it", () => {
    expect(
      toEventFeedbackVenueSnapshot({
        ...EMPTY_VENUE,
        venueProvider: "google",
        venuePlaceId: "ChIJtest",
        venueLabel: "Test venue",
        venueUseInFeedback: false,
        venueContextRevision: 6,
      }),
    ).toEqual({ contextRevision: 6, venue: null });
  });
});
