export interface GooglePlaceSelection {
  placeId: string;
  label: string;
  area: string;
  type: string;
}

interface CanonicalPlaceDetails {
  readonly displayName: string | null | undefined;
  readonly formattedAddress: string | null | undefined;
  readonly primaryTypeDisplayName: string | null | undefined;
}

const GENERIC_PLACE_TYPES = new Set([
  "establishment",
  "food",
  "point_of_interest",
]);

function readablePlaceType(types: readonly string[]): string {
  const specificType = types.find((type) => !GENERIC_PLACE_TYPES.has(type));
  if (specificType === undefined) {
    return "";
  }

  const readable = specificType.replaceAll("_", " ");
  return `${readable.charAt(0).toUpperCase()}${readable.slice(1)}`;
}

export function selectionFromPrediction(prediction: {
  readonly placeId: string;
  readonly mainText: { readonly text: string } | null;
  readonly secondaryText: { readonly text: string } | null;
  readonly text: { readonly text: string };
  readonly types: readonly string[];
}): GooglePlaceSelection {
  return {
    placeId: prediction.placeId,
    label: (prediction.mainText?.text ?? prediction.text.text).trim(),
    area: prediction.secondaryText?.text.trim() ?? "",
    type: readablePlaceType(prediction.types),
  };
}

/**
 * A prediction may echo an alternative spelling matching the query instead of
 * the place's canonical name. Prefer the one selection-scoped details result,
 * while retaining prediction text as a resilient fallback.
 */
export function selectionFromPlaceDetails(
  prediction: Parameters<typeof selectionFromPrediction>[0],
  details: CanonicalPlaceDetails,
): GooglePlaceSelection {
  const fallback = selectionFromPrediction(prediction);

  return {
    placeId: fallback.placeId,
    label: details.displayName?.trim() || fallback.label,
    area: details.formattedAddress?.trim() || fallback.area,
    type: details.primaryTypeDisplayName?.trim() || fallback.type,
  };
}
