import {
  Button,
  Input,
  ListBox,
  Modal,
  Select,
  Slider,
  Switch,
} from "@heroui/react";
import { MapPin, NotebookPen, PencilLine, Trash2 } from "lucide-react";
import { type FormEvent, useCallback, useId, useState } from "react";

import { UpdateEventBody } from "../../../api/generated/zod/events.zod";
import {
  VENUE_PRICE_CURRENCY,
  VENUE_PRICE_LEVELS,
  VENUE_PRICE_RANGE_DEFAULT,
  VENUE_PRICE_RANGE_MAX,
  VENUE_PRICE_RANGE_MIN,
  VENUE_PRICE_RANGE_STEP,
  type EventVenueUpdate,
  type EventVenueValue,
  type VenuePriceLevel,
  formatVenuePriceMajorLabel,
  parseVenuePriceMajor,
  snapVenuePriceMajor,
  venueMajorToMinor,
  venueMinorToMajorInput,
  venuePriceLevelLabel,
} from "../../../features/event/venue";
import type { GooglePlaceSelection } from "../../../features/event/googlePlacePrediction";
import { apiErrorMessage } from "../../../lib/api";
import { VenueDetails } from "./VenueDisplay";
import { VenueGoogleSelection } from "./VenueGoogleSelection";

const NO_PRICE_LEVEL = "none";

interface VenueDraft {
  placeId: string;
  label: string;
  type: string;
  area: string;
  priceLevel: VenuePriceLevel | "";
  priceStart: number;
  priceEnd: number;
  useInFeedback: boolean;
}

interface EventVenueCardProps {
  venue: EventVenueValue | null;
  canEdit: boolean;
  isPending: boolean;
  onSave: (venue: EventVenueUpdate | null) => Promise<void>;
}

function venueDraft(venue: EventVenueValue | null): VenueDraft {
  const range = venue?.priceRange;
  let priceStart = VENUE_PRICE_RANGE_DEFAULT[0];
  let priceEnd = VENUE_PRICE_RANGE_DEFAULT[1];

  if (range !== undefined) {
    const startMajor =
      parseVenuePriceMajor(
        venueMinorToMajorInput(range.startMinor, range.currencyCode),
      ) ?? VENUE_PRICE_RANGE_DEFAULT[0];
    const endMajor =
      range.endMinor === undefined
        ? startMajor
        : (parseVenuePriceMajor(
            venueMinorToMajorInput(range.endMinor, range.currencyCode),
          ) ?? startMajor);
    priceStart = Math.min(startMajor, endMajor);
    priceEnd = Math.max(startMajor, endMajor);
  }

  return {
    placeId: venue?.placeId ?? "",
    label: venue?.label ?? "",
    type: venue?.type ?? "",
    area: venue?.area ?? "",
    priceLevel: venue?.priceLevel ?? "",
    priceStart,
    priceEnd,
    useInFeedback: venue?.useInFeedback ?? true,
  };
}

function optionalText(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function VenueEditorAction({
  venue,
  isPending,
  onSave,
}: Omit<EventVenueCardProps, "canEdit">) {
  const labelInputId = useId();
  const typeInputId = useId();
  const areaInputId = useId();
  const priceRangeSliderId = useId();

  const [isOpen, setOpen] = useState(false);
  const [draft, setDraft] = useState(() => venueDraft(venue));
  const [previewPlaceId, setPreviewPlaceId] = useState("");
  const [googleLookupPending, setGoogleLookupPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function resetDraft() {
    setDraft(venueDraft(venue));
    setPreviewPlaceId("");
    setGoogleLookupPending(false);
    setError(null);
  }

  function handleOpenChange(open: boolean) {
    if (isPending) {
      return;
    }
    if (open) {
      resetDraft();
    }
    setOpen(open);
  }

  const selectGooglePlace = useCallback((selection: GooglePlaceSelection) => {
    setError(null);
    setDraft((current) => ({
      ...venueDraft(null),
      placeId: selection.placeId,
      label: selection.label,
      type: selection.type,
      area: selection.area,
      useInFeedback: current.useInFeedback,
    }));
    setPreviewPlaceId(selection.placeId);
  }, []);

  async function handleSubmit(formEvent: FormEvent<HTMLFormElement>) {
    formEvent.preventDefault();
    setError(null);

    const startMinor = venueMajorToMinor(
      String(draft.priceStart),
      VENUE_PRICE_CURRENCY,
    );
    const endMinor = venueMajorToMinor(
      String(draft.priceEnd),
      VENUE_PRICE_CURRENCY,
    );
    if (startMinor === null || endMinor === null) {
      setError("The price range must use zero or positive amounts.");
      return;
    }
    if (endMinor < startMinor) {
      setError("The end price cannot be lower than the start price.");
      return;
    }

    const type = optionalText(draft.type);
    const area = optionalText(draft.area);
    const nextVenue: EventVenueUpdate = {
      provider: "google",
      placeId: draft.placeId.trim(),
      label: draft.label.trim(),
      useInFeedback: draft.useInFeedback,
      ...(type === undefined ? {} : { type }),
      ...(area === undefined ? {} : { area }),
      ...(draft.priceLevel === "" ? {} : { priceLevel: draft.priceLevel }),
      priceRange: {
        startMinor,
        endMinor,
        currencyCode: VENUE_PRICE_CURRENCY,
      },
    };

    const validated = UpdateEventBody.safeParse({ venue: nextVenue });
    if (!validated.success || validated.data.venue == null) {
      setError(
        validated.success
          ? "The venue payload is missing."
          : (validated.error.issues[0]?.message ??
              "Check the venue fields and try again."),
      );
      return;
    }

    try {
      await onSave(nextVenue);
      setOpen(false);
    } catch (cause) {
      setError(apiErrorMessage(cause, "The venue could not be saved."));
    }
  }

  async function removeVenue() {
    setError(null);
    try {
      await onSave(null);
      setOpen(false);
    } catch (cause) {
      setError(apiErrorMessage(cause, "The venue could not be removed."));
    }
  }

  return (
    <Modal isOpen={isOpen} onOpenChange={handleOpenChange}>
      <Button size="sm" variant="secondary">
        <PencilLine aria-hidden="true" className="size-4" />
        {venue === null ? "Add venue" : "Edit venue"}
      </Button>
      {isOpen ? (
        <Modal.Backdrop isDismissable={!isPending}>
          <Modal.Container size="lg" placement="center" scroll="inside">
            <Modal.Dialog>
              <form onSubmit={handleSubmit} className="contents">
                <Modal.Header className="flex items-start justify-between gap-4">
                  <Modal.Heading className="text-[1.05rem] font-bold tracking-tight text-ink">
                    {venue === null ? "Add venue" : "Edit venue"}
                  </Modal.Heading>
                  <Modal.CloseTrigger isDisabled={isPending} />
                </Modal.Header>

                <Modal.Body className="grid min-w-0 gap-5">
                  <VenueGoogleSelection
                    disabled={isPending}
                    placeId={draft.placeId}
                    previewPlaceId={previewPlaceId}
                    onPlaceSelect={selectGooglePlace}
                    onLookupPendingChange={setGoogleLookupPending}
                    onManualPlaceIdChange={(placeId) => {
                      setDraft((current) => ({ ...current, placeId }));
                      setPreviewPlaceId("");
                    }}
                    onLoadPreview={() =>
                      setPreviewPlaceId(draft.placeId.trim())
                    }
                  />

                  <section
                    className="grid min-w-0 gap-4"
                    aria-label="Operator-confirmed venue context"
                  >
                    <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
                      <NotebookPen
                        aria-hidden="true"
                        className="size-4 shrink-0 text-ink-muted"
                      />
                      Our context
                    </h3>

                    <div className="grid min-w-0 gap-4 md:grid-cols-2">
                      <div className="grid min-w-0 gap-1.5 md:col-span-2">
                        <label
                          htmlFor={labelInputId}
                          className="text-sm font-semibold"
                        >
                          Label
                        </label>
                        <Input
                          id={labelInputId}
                          value={draft.label}
                          onChange={(change) =>
                            setDraft((current) => ({
                              ...current,
                              label: change.target.value,
                            }))
                          }
                          disabled={isPending}
                          placeholder="Name Luna should use"
                          maxLength={200}
                          required
                          className="w-full min-w-0"
                        />
                      </div>

                      <div className="grid min-w-0 gap-1.5">
                        <label
                          htmlFor={typeInputId}
                          className="text-sm font-semibold"
                        >
                          Type
                        </label>
                        <Input
                          id={typeInputId}
                          value={draft.type}
                          onChange={(change) =>
                            setDraft((current) => ({
                              ...current,
                              type: change.target.value,
                            }))
                          }
                          disabled={isPending}
                          placeholder="Restaurant, wine bar…"
                          maxLength={100}
                          className="w-full min-w-0"
                        />
                      </div>

                      <div className="grid min-w-0 gap-1.5">
                        <label
                          htmlFor={areaInputId}
                          className="text-sm font-semibold"
                        >
                          Area
                        </label>
                        <Input
                          id={areaInputId}
                          value={draft.area}
                          onChange={(change) =>
                            setDraft((current) => ({
                              ...current,
                              area: change.target.value,
                            }))
                          }
                          disabled={isPending}
                          placeholder="Kolonaki, Athens…"
                          maxLength={200}
                          className="w-full min-w-0"
                        />
                      </div>

                      <div className="grid min-w-0 gap-1.5 md:col-span-2">
                        <span className="text-sm font-semibold">
                          Price level
                        </span>
                        <Select
                          aria-label="Operator-confirmed venue price level"
                          selectedKey={draft.priceLevel || NO_PRICE_LEVEL}
                          onSelectionChange={(key) => {
                            const value = String(key ?? NO_PRICE_LEVEL);
                            setDraft((current) => ({
                              ...current,
                              priceLevel:
                                value === NO_PRICE_LEVEL
                                  ? ""
                                  : (value as VenuePriceLevel),
                            }));
                          }}
                          isDisabled={isPending}
                          className="w-full min-w-0"
                        >
                          <Select.Trigger className="w-full min-w-0">
                            <Select.Value />
                            <Select.Indicator />
                          </Select.Trigger>
                          <Select.Popover>
                            <ListBox>
                              <ListBox.Item
                                id={NO_PRICE_LEVEL}
                                textValue="Not set"
                              >
                                Not set
                              </ListBox.Item>
                              {VENUE_PRICE_LEVELS.map((level) => (
                                <ListBox.Item
                                  key={level}
                                  id={level}
                                  textValue={venuePriceLevelLabel(level)}
                                >
                                  {venuePriceLevelLabel(level)}
                                </ListBox.Item>
                              ))}
                            </ListBox>
                          </Select.Popover>
                        </Select>
                      </div>

                      <fieldset className="grid min-w-0 gap-3 md:col-span-2">
                        <legend className="text-sm font-semibold">
                          Price range / person
                        </legend>
                        <div className="grid min-w-0 gap-3">
                          <Slider
                            id={priceRangeSliderId}
                            aria-label="Typical price range per person in euro"
                            minValue={VENUE_PRICE_RANGE_MIN}
                            maxValue={VENUE_PRICE_RANGE_MAX}
                            step={VENUE_PRICE_RANGE_STEP}
                            value={[draft.priceStart, draft.priceEnd]}
                            isDisabled={isPending}
                            onChange={(value) => {
                              if (!Array.isArray(value)) {
                                return;
                              }
                              const start = snapVenuePriceMajor(
                                value[0] ?? draft.priceStart,
                              );
                              const end = snapVenuePriceMajor(
                                value[1] ?? draft.priceEnd,
                              );
                              setDraft((current) => ({
                                ...current,
                                priceStart: Math.min(start, end),
                                priceEnd: Math.max(start, end),
                              }));
                            }}
                            className="w-full min-w-0"
                          >
                            <Slider.Track>
                              <Slider.Fill />
                              <Slider.Thumb
                                index={0}
                                aria-label="Minimum price per person"
                              />
                              <Slider.Thumb
                                index={1}
                                aria-label="Maximum price per person"
                              />
                            </Slider.Track>
                          </Slider>
                          <div className="flex items-start justify-between gap-3">
                            <div className="grid gap-0.5">
                              <span className="text-xs text-ink-muted">
                                From
                              </span>
                              <span className="text-sm font-semibold tabular-nums text-ink">
                                {formatVenuePriceMajorLabel(
                                  draft.priceStart,
                                  VENUE_PRICE_CURRENCY,
                                )}
                              </span>
                            </div>
                            <div className="grid gap-0.5 text-right">
                              <span className="text-xs text-ink-muted">To</span>
                              <span className="text-sm font-semibold tabular-nums text-ink">
                                {formatVenuePriceMajorLabel(
                                  draft.priceEnd,
                                  VENUE_PRICE_CURRENCY,
                                )}
                              </span>
                            </div>
                          </div>
                        </div>
                      </fieldset>
                    </div>

                    <Switch
                      isSelected={draft.useInFeedback}
                      onChange={(useInFeedback) =>
                        setDraft((current) => ({
                          ...current,
                          useInFeedback,
                        }))
                      }
                      isDisabled={isPending}
                    >
                      <Switch.Content>
                        <Switch.Control>
                          <Switch.Thumb />
                        </Switch.Control>
                        <span className="text-sm font-semibold">
                          Use venue context in Luna
                        </span>
                      </Switch.Content>
                    </Switch>
                  </section>

                  {error ? (
                    <p role="alert" className="text-sm text-danger">
                      {error}
                    </p>
                  ) : null}
                </Modal.Body>

                <Modal.Footer className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    {venue !== null ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="danger-soft"
                        isDisabled={isPending}
                        onPress={() => {
                          void removeVenue();
                        }}
                      >
                        <Trash2 aria-hidden="true" className="size-4" />
                        Remove venue
                      </Button>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    <Button
                      type="button"
                      variant="ghost"
                      isDisabled={isPending}
                      onPress={() => handleOpenChange(false)}
                    >
                      Cancel
                    </Button>
                    <Button
                      type="submit"
                      isDisabled={isPending || googleLookupPending}
                    >
                      {isPending
                        ? "Saving…"
                        : googleLookupPending
                          ? "Loading venue…"
                          : "Save venue"}
                    </Button>
                  </div>
                </Modal.Footer>
              </form>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      ) : null}
    </Modal>
  );
}

/**
 * Clean event summary. Editing is intentionally delegated to a modal so the
 * location reads like event information instead of a permanent database form.
 */
export function EventVenueCard({
  venue,
  canEdit,
  isPending,
  onSave,
}: EventVenueCardProps) {
  return (
    // The same card grammar as the attendance table below it: titled header
    // bar, rule, body. A section that sits between two of those cannot afford
    // to be shaped differently.
    <section
      aria-labelledby="event-venue-heading"
      className="min-w-0 overflow-hidden rounded-md border border-border bg-surface"
    >
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-border px-5 py-4 max-sm:flex-col max-sm:items-start">
        <div className="min-w-0">
          <h2
            id="event-venue-heading"
            className="flex items-center gap-2 text-[1.05rem] font-bold tracking-tight text-ink"
          >
            <MapPin
              aria-hidden="true"
              className="size-4 shrink-0 text-ink-subtle"
            />
            Venue
          </h2>
          <p className="mt-1 text-sm text-ink-muted">
            Where the table was booked, and the context Luna is allowed to reuse
            when it asks for feedback.
          </p>
        </div>
        {canEdit ? (
          <VenueEditorAction
            venue={venue}
            isPending={isPending}
            onSave={onSave}
          />
        ) : null}
      </div>

      <div className="min-w-0 px-5 py-4">
        {venue === null ? (
          <div className="flex min-w-0 items-start gap-3 rounded-md border border-dashed border-border bg-surface-sunken px-4 py-4">
            <MapPin
              aria-hidden="true"
              className="mt-0.5 size-5 shrink-0 text-ink-subtle"
            />
            <div className="min-w-0">
              <p className="font-semibold text-ink">No venue connected</p>
              <p className="mt-1 text-sm text-ink-muted">
                The event still works; it simply has no location context yet.
              </p>
            </div>
          </div>
        ) : (
          <VenueDetails venue={venue} />
        )}
      </div>
    </section>
  );
}
