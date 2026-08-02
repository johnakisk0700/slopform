import { Chip } from "@heroui/react";
import { ExternalLink, MapPin } from "lucide-react";

import {
  formatVenuePriceContext,
  formatVenuePriceRange,
  googleMapsPlaceUrl,
  venuePriceLevelLabel,
  type EventVenueValue,
} from "../../../features/event/venue";

interface VenueDisplayProps {
  venue: EventVenueValue;
}

/** Compact persisted context, ready for dense surfaces; it makes no API call. */
export function VenueCompact({ venue }: VenueDisplayProps) {
  const context = [
    venue.type,
    venue.area,
    formatVenuePriceContext(venue),
  ].filter((value): value is string => Boolean(value));

  return (
    <div className="flex min-w-0 items-start gap-2">
      <MapPin
        aria-hidden="true"
        className="mt-0.5 size-4 shrink-0 text-ink-subtle"
      />
      <div className="min-w-0">
        <a
          href={googleMapsPlaceUrl(venue)}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex max-w-full items-center gap-1 font-semibold text-primary hover:underline"
        >
          <span className="truncate">{venue.label}</span>
          <ExternalLink aria-hidden="true" className="size-3.5 shrink-0" />
        </a>
        {context.length > 0 ? (
          <p className="truncate text-xs text-ink-muted">
            {context.join(" · ")}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** Rich no-request event view: persisted context plus a plain Maps link. */
export function VenueDetails({ venue }: VenueDisplayProps) {
  // Level and range are both operator-authored, so a card that shows only one
  // of them quietly drops context Luna was given.
  const price =
    [
      venue.priceRange ? formatVenuePriceRange(venue.priceRange) : null,
      venue.priceLevel ? venuePriceLevelLabel(venue.priceLevel) : null,
    ]
      .filter(Boolean)
      .join(" · ") || null;

  // Every slot is stated even when empty: an operator has to be able to tell
  // "nothing recorded" apart from "nothing to record".
  const metadata = [
    { label: "Type", value: venue.type ?? null },
    { label: "Area", value: venue.area ?? null },
    { label: "Price / person", value: price },
  ];

  return (
    <div className="grid min-w-0 gap-4">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
        <a
          href={googleMapsPlaceUrl(venue)}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex min-w-0 max-w-full items-center gap-1.5 text-lg font-bold text-primary hover:underline"
          aria-label={`Open ${venue.label} in Google Maps`}
        >
          <span className="truncate">{venue.label}</span>
          <ExternalLink aria-hidden="true" className="size-4 shrink-0" />
        </a>
        <Chip
          color={venue.useInFeedback ? "success" : "default"}
          size="sm"
          variant="soft"
        >
          <Chip.Label>
            {venue.useInFeedback ? "Used by Luna" : "Not used by Luna"}
          </Chip.Label>
        </Chip>
      </div>

      {/* Wrapping rather than thirds: the values sit next to each other and
          read as one line of context instead of drifting apart. */}
      <dl className="flex min-w-0 flex-wrap gap-x-10 gap-y-4">
        {metadata.map((item) => (
          <div key={item.label} className="min-w-0">
            <dt className="jts-overline text-ink-muted">{item.label}</dt>
            <dd
              className={
                item.value === null
                  ? "mt-0.5 text-sm text-ink-subtle"
                  : "mt-0.5 text-sm text-ink"
              }
            >
              {item.value ?? "—"}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
