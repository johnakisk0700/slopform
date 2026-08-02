import type { EventDetailDtoOutputVenue } from "../../api/generated/model/eventDetailDtoOutputVenue";
import type { UpdateEventDtoVenue } from "../../api/generated/model/updateEventDtoVenue";
import {
  UpdateEventDtoVenuePriceLevel,
  type UpdateEventDtoVenuePriceLevel as GeneratedVenuePriceLevel,
} from "../../api/generated/model/updateEventDtoVenuePriceLevel";

/** The API owns these shapes; the feature layer only formats them. */
export type EventVenueValue = NonNullable<EventDetailDtoOutputVenue>;
export type EventVenueUpdate = NonNullable<UpdateEventDtoVenue>;
export type VenuePriceLevel = GeneratedVenuePriceLevel;
export type VenuePriceRange = NonNullable<EventVenueUpdate["priceRange"]>;

export const VENUE_PRICE_LEVELS = Object.values(UpdateEventDtoVenuePriceLevel);

const PRICE_LEVEL_LABELS: Record<VenuePriceLevel, string> = {
  free: "Free",
  inexpensive: "Inexpensive",
  moderate: "Moderate",
  expensive: "Expensive",
  very_expensive: "Very expensive",
};

export function venuePriceLevelLabel(level: VenuePriceLevel): string {
  return PRICE_LEVEL_LABELS[level];
}

/** A normal link; opening it does not load the Maps JavaScript API. */
export function googleMapsPlaceUrl(
  venue: Pick<EventVenueValue, "label" | "placeId">,
): string {
  const url = new URL("https://www.google.com/maps/search/");
  url.search = new URLSearchParams({
    api: "1",
    query: venue.label,
    query_place_id: venue.placeId,
  }).toString();
  return url.toString();
}

function currencyFractionDigits(currencyCode: string): number {
  try {
    return (
      new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: currencyCode,
      }).resolvedOptions().maximumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
}

export function venueMinorToMajorInput(
  minor: number,
  currencyCode: string,
): string {
  const divisor = 10 ** currencyFractionDigits(currencyCode);
  return String(minor / divisor);
}

export function venueMajorToMinor(
  major: string,
  currencyCode: string,
): number | null {
  const parsed = Number(major);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }

  const multiplier = 10 ** currencyFractionDigits(currencyCode);
  return Math.round(parsed * multiplier);
}

/** Operator price-range slider: major units, $5-style steps. */
export const VENUE_PRICE_RANGE_MIN = 0;
export const VENUE_PRICE_RANGE_MAX = 150;
export const VENUE_PRICE_RANGE_STEP = 5;
export const VENUE_PRICE_RANGE_DEFAULT: readonly [number, number] = [30, 50];
/** Venue editor always stores typical price range in euro. */
export const VENUE_PRICE_CURRENCY = "EUR";

export function snapVenuePriceMajor(major: number): number {
  if (!Number.isFinite(major) || major < VENUE_PRICE_RANGE_MIN) {
    return VENUE_PRICE_RANGE_MIN;
  }
  const capped = Math.min(major, VENUE_PRICE_RANGE_MAX);
  return Math.round(capped / VENUE_PRICE_RANGE_STEP) * VENUE_PRICE_RANGE_STEP;
}

/**
 * Parses a draft major-unit string into a snapped slider value, or null when
 * the field is empty / not a number.
 */
export function parseVenuePriceMajor(major: string): number | null {
  const trimmed = major.trim();
  if (trimmed === "") {
    return null;
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }
  return snapVenuePriceMajor(parsed);
}

/** Formats a major amount with the draft currency for under-slider labels. */
export function formatVenuePriceMajorLabel(
  major: number,
  currencyCode: string,
): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currencyCode,
      maximumFractionDigits: 0,
      minimumFractionDigits: 0,
    }).format(major);
  } catch {
    return `${major} ${currencyCode}`;
  }
}

export function formatVenuePriceRange(range: VenuePriceRange): string {
  try {
    const digits = currencyFractionDigits(range.currencyCode);
    const divisor = 10 ** digits;
    const start = range.startMinor / divisor;
    const end =
      range.endMinor === undefined ? undefined : range.endMinor / divisor;
    // The slider only stops on whole steps, so ".00" is a decimal an operator
    // reads past. Cents stay visible the moment a value actually has them.
    const whole =
      Number.isInteger(start) && (end === undefined || Number.isInteger(end));
    const formatter = new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: range.currencyCode,
      minimumFractionDigits: whole ? 0 : digits,
      maximumFractionDigits: digits,
    });
    return end === undefined
      ? `From ${formatter.format(start)}`
      : `${formatter.format(start)}–${formatter.format(end)}`;
  } catch {
    const end = range.endMinor === undefined ? "" : `–${range.endMinor}`;
    return `${range.startMinor}${end} ${range.currencyCode}`;
  }
}

export function formatVenuePriceContext(
  venue: Pick<EventVenueValue, "priceLevel" | "priceRange">,
): string | null {
  if (venue.priceRange) {
    return formatVenuePriceRange(venue.priceRange);
  }
  return venue.priceLevel ? venuePriceLevelLabel(venue.priceLevel) : null;
}
