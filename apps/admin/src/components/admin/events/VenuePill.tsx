import { ExternalLink, MapPin } from "lucide-react";

import {
  googleMapsPlaceUrl,
  type EventVenueValue,
} from "../../../features/event/venue";

/**
 * The no-request venue form: a normal Google Maps deep-link with persisted
 * text. It deliberately has no dependency on the Places UI Kit adapter.
 */
export function VenuePill({ venue }: { venue: EventVenueValue }) {
  return (
    <a
      href={googleMapsPlaceUrl(venue)}
      target="_blank"
      rel="noreferrer noopener"
      className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-surface-sunken px-2.5 py-1 text-xs font-semibold text-ink-muted hover:border-primary hover:text-primary"
      aria-label={`Open ${venue.label} in Google Maps`}
    >
      <MapPin aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="truncate">{venue.label}</span>
      <ExternalLink aria-hidden="true" className="size-3 shrink-0" />
    </a>
  );
}
