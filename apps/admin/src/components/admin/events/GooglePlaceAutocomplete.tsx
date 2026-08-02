import { useEffect, useRef, useState } from "react";

import {
  GOOGLE_PLACES_CONFIGURATION_ERROR_MESSAGE,
  googlePlacesIsConfigured,
  loadGooglePlaces,
} from "../../../lib/googlePlaces";
import { useTheme } from "../../../lib/useTheme";
import {
  type GooglePlaceSelection,
  selectionFromPlaceDetails,
  selectionFromPrediction,
} from "../../../features/event/googlePlacePrediction";

interface GooglePlaceAutocompleteProps {
  disabled: boolean;
  onPlaceSelect: (selection: GooglePlaceSelection) => void;
  onLookupPendingChange: (pending: boolean) => void;
}

type SearchState = "idle" | "resolving" | "selected" | "degraded" | "failed";

/**
 * Styles Google's host element with documented CSS properties only. The widget
 * keeps its own shadow DOM; we match JTS inputs via tokens + color-scheme.
 */
function applyAutocompleteHostStyles(
  element: HTMLElement,
  isDark: boolean,
): void {
  element.style.display = "block";
  element.style.width = "100%";
  element.style.minWidth = "0";
  element.style.height = "2.5rem";
  element.style.boxSizing = "border-box";
  element.style.backgroundColor = "var(--jts-color-surface-raised)";
  element.style.border = "1px solid var(--jts-color-border)";
  element.style.borderRadius = "var(--jts-radius-md)";
  element.style.color = "var(--jts-color-text)";
  element.style.fontFamily = "var(--jts-font-sans)";
  element.style.fontSize = "var(--jts-text-sm)";
  element.style.fontWeight = "var(--jts-weight-regular)";
  element.style.lineHeight = "var(--jts-leading-snug)";
  element.style.colorScheme = isDark ? "dark" : "light";
}

/**
 * Google Place Autocomplete. A completed selection makes exactly one details
 * request for canonical name/address/type; ordinary renders make none.
 */
export function GooglePlaceAutocomplete({
  disabled,
  onPlaceSelect,
  onLookupPendingChange,
}: GooglePlaceAutocompleteProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { isDark } = useTheme();
  const [state, setState] = useState<SearchState>("idle");
  const configured = googlePlacesIsConfigured();

  useEffect(() => {
    const container = containerRef.current;
    if (!configured || container === null) {
      return;
    }

    let active = true;
    let selectionRevision = 0;
    let autocomplete: google.maps.places.PlaceAutocompleteElement | null = null;

    void loadGooglePlaces()
      .then(({ Place, PlaceAutocompleteElement }) => {
        if (!active) {
          return;
        }

        autocomplete = new PlaceAutocompleteElement({
          description: "Search Google Maps for the event venue",
          disabled,
          includedRegionCodes: ["gr"],
          placeholder: "Search Google Maps…",
          requestedRegion: "gr",
        });
        autocomplete.className = "jts-google-place-autocomplete";
        applyAutocompleteHostStyles(autocomplete, isDark);
        autocomplete.addEventListener("gmp-select", (event) => {
          if (!active) {
            return;
          }

          const prediction = event.placePrediction;
          const fallback = selectionFromPrediction(prediction);
          const revision = ++selectionRevision;
          setState("resolving");
          onLookupPendingChange(true);

          // A standalone Place keeps this low-volume admin lookup on the normal
          // field-mask SKU instead of the widget session's costlier termination
          // tier. It is still exactly one details request per accepted result.
          const place = new Place({ id: prediction.placeId });
          void place
            .fetchFields({
              fields: [
                "displayName",
                "formattedAddress",
                "primaryTypeDisplayName",
              ],
            })
            .then(({ place: canonicalPlace }) => {
              if (!active || revision !== selectionRevision) {
                return;
              }
              onPlaceSelect(
                selectionFromPlaceDetails(prediction, canonicalPlace),
              );
              setState("selected");
              onLookupPendingChange(false);
            })
            .catch(() => {
              if (!active || revision !== selectionRevision) {
                return;
              }
              onPlaceSelect(fallback);
              setState("degraded");
              onLookupPendingChange(false);
            });
        });
        autocomplete.addEventListener("gmp-error", () => {
          if (active) {
            setState("failed");
            onLookupPendingChange(false);
          }
        });
        container.replaceChildren(autocomplete);
      })
      .catch(() => {
        if (active) {
          setState("failed");
          onLookupPendingChange(false);
        }
      });

    return () => {
      active = false;
      onLookupPendingChange(false);
      autocomplete?.remove();
    };
  }, [configured, disabled, isDark, onLookupPendingChange, onPlaceSelect]);

  if (!configured) {
    return (
      <div className="grid gap-1 text-sm text-ink-muted">
        <p>Google search needs a browser key.</p>
        <a
          href="https://developers.google.com/maps/documentation/javascript/demo-key"
          target="_blank"
          rel="noreferrer noopener"
          className="w-fit font-semibold text-primary hover:underline"
        >
          Learn about Google's no-billing Demo Key
        </a>
      </div>
    );
  }

  return (
    <div className="grid min-w-0 gap-2">
      {/* One surface only: the Google host is the input. No outer shell. */}
      <div
        ref={containerRef}
        className="min-h-10 min-w-0"
        aria-label="Search Google Maps"
      />
      {state === "failed" ? (
        <p role="status" className="text-sm text-warning">
          {GOOGLE_PLACES_CONFIGURATION_ERROR_MESSAGE}
        </p>
      ) : state === "resolving" ? (
        <p role="status" className="text-sm text-ink-muted">
          Loading canonical Google details…
        </p>
      ) : state === "degraded" ? (
        <p role="status" className="text-sm text-warning">
          Canonical details could not load. Prediction text filled instead —
          review it before saving.
        </p>
      ) : state === "selected" ? (
        <p role="status" className="text-sm text-success">
          Canonical name, address and type filled below — review before saving.
        </p>
      ) : null}
      <p className="text-xs text-ink-subtle">
        One details lookup runs only after selection; price remains
        operator-authored.
      </p>
    </div>
  );
}
