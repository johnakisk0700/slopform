import { Button, Input } from "@heroui/react";
import { Eye, Search } from "lucide-react";
import { useId } from "react";

import type { GooglePlaceSelection } from "../../../features/event/googlePlacePrediction";
import { googlePlacesIsConfigured } from "../../../lib/googlePlaces";
import { GooglePlaceAutocomplete } from "./GooglePlaceAutocomplete";
import { GooglePlaceDetails } from "./GooglePlaceDetails";

interface VenueGoogleSelectionProps {
  disabled: boolean;
  placeId: string;
  previewPlaceId: string;
  onPlaceSelect: (selection: GooglePlaceSelection) => void;
  onLookupPendingChange: (pending: boolean) => void;
  onManualPlaceIdChange: (placeId: string) => void;
  onLoadPreview: () => void;
}

/**
 * The only event-editor surface that can mount Google code. The parent renders
 * it only while the modal is open, and details mount only after selection or
 * an explicit preview action.
 */
export function VenueGoogleSelection({
  disabled,
  placeId,
  previewPlaceId,
  onPlaceSelect,
  onLookupPendingChange,
  onManualPlaceIdChange,
  onLoadPreview,
}: VenueGoogleSelectionProps) {
  const placeIdInputId = useId();
  const placesConfigured = googlePlacesIsConfigured();

  return (
    <>
      <section className="grid min-w-0 gap-3" aria-label="Google place">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
          <Search
            aria-hidden="true"
            className="size-4 shrink-0 text-ink-muted"
          />
          Find place
        </h3>
        <GooglePlaceAutocomplete
          disabled={disabled}
          onPlaceSelect={onPlaceSelect}
          onLookupPendingChange={onLookupPendingChange}
        />

        <details
          className="min-w-0 rounded-md border border-border-subtle bg-surface-sunken px-3 py-2"
          open={placesConfigured ? undefined : true}
        >
          <summary className="cursor-pointer text-sm font-semibold text-ink-muted">
            Place ID
          </summary>
          <div className="mt-3 grid min-w-0 gap-2">
            <label htmlFor={placeIdInputId} className="sr-only">
              Google Place ID
            </label>
            <Input
              id={placeIdInputId}
              value={placeId}
              onChange={(change) => onManualPlaceIdChange(change.target.value)}
              disabled={disabled}
              required
              placeholder="ChIJ…"
              className="w-full min-w-0 font-mono"
            />
          </div>
        </details>

        {placeId.trim() !== "" && previewPlaceId === "" ? (
          <div className="flex justify-end">
            <Button
              type="button"
              size="sm"
              variant="secondary"
              isDisabled={disabled}
              onPress={onLoadPreview}
            >
              Preview
            </Button>
          </div>
        ) : null}
      </section>

      {previewPlaceId !== "" ? (
        <section
          className="grid min-w-0 gap-2"
          aria-label="Live Google preview"
        >
          <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
            <Eye
              aria-hidden="true"
              className="size-4 shrink-0 text-ink-muted"
            />
            Preview
          </h3>
          <GooglePlaceDetails key={previewPlaceId} placeId={previewPlaceId} />
        </section>
      ) : null}
    </>
  );
}
