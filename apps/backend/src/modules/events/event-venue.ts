import type { EventRow } from "@slopform/database";

import { type EventVenueView } from "./events.schemas.js";

type EventVenueColumns = Pick<
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
>;

/**
 * The deliberately small event context exposed to feedback generation.
 * Google identifiers and live/UGC metadata never cross this boundary.
 */
export type EventFeedbackVenueContext = Pick<
  EventVenueView,
  "label" | "type" | "area" | "priceLevel" | "priceRange"
>;

export interface EventFeedbackVenueSnapshot {
  /** Changes on every venue replacement, clear or feedback-toggle edit. */
  readonly contextRevision: number;
  /** Null when the event has no venue or staff disabled feedback use. */
  readonly venue: EventFeedbackVenueContext | null;
}

/** Reassembles the venue from database-constrained relational columns. */
export function toEventVenueView(
  row: EventVenueColumns,
): EventVenueView | null {
  if (row.venueProvider === null) return null;

  return {
    provider: "google",
    placeId: row.venuePlaceId!,
    label: row.venueLabel!,
    ...(row.venueType !== null ? { type: row.venueType } : {}),
    ...(row.venueArea !== null ? { area: row.venueArea } : {}),
    ...(row.venuePriceLevel !== null
      ? {
          priceLevel: row.venuePriceLevel as NonNullable<
            EventVenueView["priceLevel"]
          >,
        }
      : {}),
    ...(row.venuePriceStartMinor !== null
      ? {
          priceRange: {
            startMinor: row.venuePriceStartMinor,
            ...(row.venuePriceEndMinor !== null
              ? { endMinor: row.venuePriceEndMinor }
              : {}),
            currencyCode: row.venuePriceCurrencyCode!,
          },
        }
      : {}),
    useInFeedback: row.venueUseInFeedback!,
    contextRevision: row.venueContextRevision,
  };
}

export function toEventFeedbackVenueSnapshot(
  row: EventVenueColumns,
): EventFeedbackVenueSnapshot {
  const venue = toEventVenueView(row);
  if (!venue?.useInFeedback) {
    return {
      contextRevision: row.venueContextRevision,
      venue: null,
    };
  }

  return {
    contextRevision: row.venueContextRevision,
    venue: {
      label: venue.label,
      ...(venue.type !== undefined ? { type: venue.type } : {}),
      ...(venue.area !== undefined ? { area: venue.area } : {}),
      ...(venue.priceLevel !== undefined
        ? { priceLevel: venue.priceLevel }
        : {}),
      ...(venue.priceRange !== undefined
        ? { priceRange: venue.priceRange }
        : {}),
    },
  };
}
