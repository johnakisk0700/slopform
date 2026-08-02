import { importLibrary, setOptions } from "@googlemaps/js-api-loader";

import { env } from "./env";

let configured = false;
let placesLibrary: Promise<google.maps.PlacesLibrary> | undefined;

export const GOOGLE_PLACES_CONFIGURATION_ERROR_MESSAGE =
  "Google venue request failed. Verify project-level API enablement, billing, key API restrictions, and allowed HTTP referrers.";

export function googlePlacesIsConfigured(): boolean {
  return env.googleMapsApiKey !== undefined;
}

/**
 * Builds the no-charge Maps Embed fallback used by an explicitly requested
 * editor preview. The iframe owns Google attribution and receives only the
 * already-selected Place ID.
 */
export function googleMapsEmbedPlaceUrl(placeId: string): string | null {
  const key = env.googleMapsApiKey;
  const trimmedPlaceId = placeId.trim();
  if (key === undefined || trimmedPlaceId === "") {
    return null;
  }

  const url = new URL("https://www.google.com/maps/embed/v1/place");
  url.search = new URLSearchParams({
    key,
    q: `place_id:${trimmedPlaceId}`,
    language: "en",
    region: "GR",
  }).toString();
  return url.toString();
}

/**
 * Loads Places only when a details/autocomplete surface is actually mounted.
 * List pills and normal Maps links never call this function.
 */
export function loadGooglePlaces(): Promise<google.maps.PlacesLibrary> {
  const key = env.googleMapsApiKey;
  if (key === undefined) {
    return Promise.reject(new Error("Google Places is not configured."));
  }

  if (!configured) {
    setOptions({
      key,
      v: "weekly",
      language: "en",
      region: "GR",
      authReferrerPolicy: "origin",
    });
    configured = true;
  }

  placesLibrary ??= importLibrary("places");
  return placesLibrary;
}
