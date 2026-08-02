import { ImageOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  GOOGLE_PLACES_CONFIGURATION_ERROR_MESSAGE,
  googleMapsEmbedPlaceUrl,
  googlePlacesIsConfigured,
  loadGooglePlaces,
} from "../../../lib/googlePlaces";

type PreviewState = "loading" | "ready" | "embed" | "unavailable";

/**
 * Live, display-only Google UI Kit details. Google owns photos and attribution;
 * neither leaves this custom element nor enters the event payload.
 */
export function GooglePlaceDetails({ placeId }: { placeId: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const configured = googlePlacesIsConfigured();
  const embedUrl = googleMapsEmbedPlaceUrl(placeId);
  const [state, setState] = useState<PreviewState>(
    configured ? "loading" : "unavailable",
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!configured || container === null) {
      setState("unavailable");
      return;
    }

    let active = true;
    let details: google.maps.places.PlaceDetailsCompactElement | null = null;
    setState("loading");

    void loadGooglePlaces()
      .then(
        ({
          PlaceDetailsCompactElement,
          PlaceDetailsPlaceRequestElement,
          PlaceStandardContentElement,
        }) => {
          if (!active) {
            return;
          }

          details = new PlaceDetailsCompactElement({
            truncationPreferred: false,
          });
          details.className = "block w-full";
          details.addEventListener("gmp-load", () => {
            if (active) {
              setState("ready");
            }
          });
          details.addEventListener("gmp-error", () => {
            if (active) {
              details?.remove();
              setState(embedUrl === null ? "unavailable" : "embed");
            }
          });
          details.append(
            new PlaceDetailsPlaceRequestElement({ place: placeId }),
            new PlaceStandardContentElement(),
          );
          container.replaceChildren(details);
        },
      )
      .catch(() => {
        if (active) {
          setState(embedUrl === null ? "unavailable" : "embed");
        }
      });

    return () => {
      active = false;
      details?.remove();
    };
  }, [configured, embedUrl, placeId]);

  return (
    <div className="relative min-h-28 overflow-hidden rounded-md border border-border bg-surface-raised">
      <div ref={containerRef} className={state === "embed" ? "hidden" : ""} />
      {state === "loading" ? (
        <p
          role="status"
          className="absolute inset-0 grid place-items-center bg-surface px-4 text-sm text-ink-muted"
        >
          Loading Google venue preview…
        </p>
      ) : null}
      {state === "embed" && embedUrl !== null ? (
        <div className="grid min-w-0 gap-3 bg-surface-sunken p-3">
          <p role="status" className="text-sm text-ink-muted">
            {GOOGLE_PLACES_CONFIGURATION_ERROR_MESSAGE} If the map also fails,
            save the manual Place ID and use the saved Google Maps link.
          </p>
          <iframe
            title="Google Maps venue preview"
            src={embedUrl}
            loading="lazy"
            allowFullScreen
            referrerPolicy="strict-origin-when-cross-origin"
            className="aspect-video min-h-64 w-full rounded-md border-0"
          />
        </div>
      ) : null}
      {state === "unavailable" ? (
        <div className="grid min-h-28 place-items-center gap-2 bg-surface-sunken px-5 py-6 text-center">
          <ImageOff aria-hidden="true" className="size-6 text-ink-subtle" />
          <p className="text-sm text-ink-muted">
            Google preview needs a browser key that permits Maps Embed API. The
            saved venue and plain Maps link still work.
          </p>
        </div>
      ) : null}
    </div>
  );
}
