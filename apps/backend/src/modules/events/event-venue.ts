import type { EventRow } from "@join-the-six/database";

import { eventVenueSchema, type EventVenueView } from "./events.schemas.js";

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

/**
 * Reassembles the normalized HTTP venue from flat relational columns.
 *
 * The database constraints make partial venue rows impossible. Parsing here is
 * still deliberate: a drifted migration or manual write fails loudly instead of
 * leaking a plausible-looking half venue through multiple read models.
 */
export function toEventVenueView(
  row: EventVenueColumns,
): EventVenueView | null {
  if (row.venueProvider === null) {
    const staleValues = [
      row.venuePlaceId,
      row.venueLabel,
      row.venueType,
      row.venueArea,
      row.venuePriceLevel,
      row.venuePriceStartMinor,
      row.venuePriceEndMinor,
      row.venuePriceCurrencyCode,
      row.venueUseInFeedback,
    ];
    if (staleValues.some((value) => value !== null)) {
      throw new Error("Event venue columns are inconsistent");
    }
    return null;
  }

  if (
    row.venuePriceStartMinor === null &&
    (row.venuePriceEndMinor !== null || row.venuePriceCurrencyCode !== null)
  ) {
    throw new Error("Event venue price columns are inconsistent");
  }

  return eventVenueSchema.parse({
    provider: row.venueProvider,
    placeId: row.venuePlaceId,
    label: row.venueLabel,
    ...(row.venueType !== null ? { type: row.venueType } : {}),
    ...(row.venueArea !== null ? { area: row.venueArea } : {}),
    ...(row.venuePriceLevel !== null
      ? { priceLevel: row.venuePriceLevel }
      : {}),
    ...(row.venuePriceStartMinor !== null
      ? {
          priceRange: {
            startMinor: row.venuePriceStartMinor,
            ...(row.venuePriceEndMinor !== null
              ? { endMinor: row.venuePriceEndMinor }
              : {}),
            currencyCode: row.venuePriceCurrencyCode,
          },
        }
      : {}),
    useInFeedback: row.venueUseInFeedback,
    contextRevision: row.venueContextRevision,
  });
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
