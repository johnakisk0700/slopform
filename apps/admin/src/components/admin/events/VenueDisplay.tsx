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

/**
 * Where the dinner was, as one framed object on a screen about something else.
 *
 * It was a two-line block: a 16px semibold link over a muted address, the pin
 * pushed down by a hand-picked `mt-0.5`. Two things were wrong with that under a
 * page title. The margin was guessed for the wrong box — a 16px glyph centres in
 * that link's 25.6px line at 4.8px, not 2px, so the pin rode ~3px high wherever
 * this rendered. And two bare lines under a heading read as a weaker second
 * heading: loud enough to compete, plain enough to skip.
 *
 * So it is one 20px line. `items-center` does the centring exactly and no margin
 * has to be picked at all, which is the actual fix — a nudged `mt-1` would only
 * have been right until the type scale moved.
 *
 * The emphasis is a copper pin and a full-strength name, not a frame. This spent
 * a version carrying its own border, which worked on one wide row and fell apart
 * on a phone: the frame stretched, the status line under it stayed bare, and the
 * band read as three unrelated treatments stacked. The border moved out to
 * whatever band renders this — `CampaignContext` on the feedback screen — so the
 * frame belongs to the thought rather than to one fact inside it.
 *
 * The context that had its own line sits behind a hairline and truncates from
 * the end: the address is the first thing worth giving up when the row runs
 * short, and Maps is one click away.
 *
 * Makes no API call.
 */
export function VenueCompact({ venue }: VenueDisplayProps) {
  const context = [
    venue.type,
    venue.area,
    formatVenuePriceContext(venue),
  ].filter((value): value is string => Boolean(value));

  return (
    <div className="flex min-w-0 items-center gap-2.5 text-sm">
      <MapPin aria-hidden="true" className="size-4 shrink-0 text-primary" />
      <a
        href={googleMapsPlaceUrl(venue)}
        target="_blank"
        rel="noreferrer noopener"
        className="inline-flex min-w-0 items-center gap-1 font-semibold text-ink hover:text-primary hover:underline"
        aria-label={`Open ${venue.label} in Google Maps`}
      >
        <span className="truncate">{venue.label}</span>
        <ExternalLink aria-hidden="true" className="size-3.5 shrink-0" />
      </a>
      {context.length > 0 ? (
        <>
          {/* The frame's own line, repeated inside it: a rule divides the name
              from its qualifiers more quietly than a dot at text weight, and it
              is the same hairline the border is drawn in. */}
          <span aria-hidden="true" className="h-4 w-px shrink-0 bg-border" />
          {/* `flex-1` is a shrink order, not a width. Basis zero means this
              takes only the room the name has left over, so a narrow row eats
              the address and keeps «Ouzeri Lesvos» whole; sharing the shrink
              proportionally cut the name to «Ouze…» at 375px to preserve an
              address that was truncated anyway. The name gives way only when it
              alone no longer fits. */}
          <p className="min-w-0 flex-1 truncate text-ink-muted">
            {context.join(" · ")}
          </p>
        </>
      ) : null}
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
