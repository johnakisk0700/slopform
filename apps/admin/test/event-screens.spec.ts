import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

function readAdminFile(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../${relativePath}`, import.meta.url)),
    "utf8",
  );
}

type EventStatus = "draft" | "scheduled" | "finished" | "cancelled";

interface ParticipantSearchFields {
  preferredName: string | null;
  emailNormalized: string;
  phoneE164: string | null;
}

interface PredictionSelection {
  placeId: string;
  label: string;
  area: string;
  type: string;
}

interface PredictionSelectionSource {
  placeId: string;
  mainText: { text: string } | null;
  secondaryText: { text: string } | null;
  text: { text: string };
  types: string[];
}

interface CanonicalPlaceDetailsSource {
  displayName: string | null | undefined;
  formattedAddress: string | null | undefined;
  primaryTypeDisplayName: string | null | undefined;
}

const ALL_STATUSES: readonly EventStatus[] = [
  "draft",
  "scheduled",
  "finished",
  "cancelled",
];

// Runtime-only specifiers, as in `api-error-message.spec.ts`: the `test` project
// and the `src` project are separate type programs, so importing across them
// statically is a TS6307. Vitest still loads the real modules.
let acceptsNewAttendees: (status: EventStatus) => boolean;
let eventStatusColor: (status: EventStatus) => string;
let eventStatusLabel: (status: EventStatus) => string;
let eventTransitionLabel: (target: EventStatus) => string;
let isEventEditable: (status: EventStatus) => boolean;
let isEventVenueEditable: (status: EventStatus) => boolean;
let nextEventStatuses: (status: EventStatus) => readonly EventStatus[];
let googleMapsPlaceUrl: (venue: { label: string; placeId: string }) => string;
let venueMajorToMinor: (major: string, currencyCode: string) => number | null;
let snapVenuePriceMajor: (major: number) => number;
let parseVenuePriceMajor: (major: string) => number | null;
let formatVenuePriceMajorLabel: (major: number, currencyCode: string) => string;
let VENUE_PRICE_RANGE_STEP: number;
let VENUE_PRICE_RANGE_MAX: number;
let compareParticipantsByName: (
  left: ParticipantSearchFields,
  right: ParticipantSearchFields,
) => number;
let matchesParticipantQuery: (
  participant: ParticipantSearchFields,
  query: string,
) => boolean;
let selectionFromPrediction: (
  prediction: PredictionSelectionSource,
) => PredictionSelection;
let selectionFromPlaceDetails: (
  prediction: PredictionSelectionSource,
  details: CanonicalPlaceDetailsSource,
) => PredictionSelection;

beforeAll(async () => {
  const status = (await import(
    new URL("../src/features/event/eventStatus.ts", import.meta.url).href
  )) as {
    acceptsNewAttendees: typeof acceptsNewAttendees;
    eventStatusColor: typeof eventStatusColor;
    eventStatusLabel: typeof eventStatusLabel;
    eventTransitionLabel: typeof eventTransitionLabel;
    isEventEditable: typeof isEventEditable;
    isEventVenueEditable: typeof isEventVenueEditable;
  };
  acceptsNewAttendees = status.acceptsNewAttendees;
  eventStatusColor = status.eventStatusColor;
  eventStatusLabel = status.eventStatusLabel;
  eventTransitionLabel = status.eventTransitionLabel;
  isEventEditable = status.isEventEditable;
  isEventVenueEditable = status.isEventVenueEditable;

  const venue = (await import(
    new URL("../src/features/event/venue.ts", import.meta.url).href
  )) as {
    googleMapsPlaceUrl: typeof googleMapsPlaceUrl;
    venueMajorToMinor: typeof venueMajorToMinor;
    snapVenuePriceMajor: typeof snapVenuePriceMajor;
    parseVenuePriceMajor: typeof parseVenuePriceMajor;
    formatVenuePriceMajorLabel: typeof formatVenuePriceMajorLabel;
    VENUE_PRICE_RANGE_STEP: typeof VENUE_PRICE_RANGE_STEP;
    VENUE_PRICE_RANGE_MAX: typeof VENUE_PRICE_RANGE_MAX;
  };
  googleMapsPlaceUrl = venue.googleMapsPlaceUrl;
  venueMajorToMinor = venue.venueMajorToMinor;
  snapVenuePriceMajor = venue.snapVenuePriceMajor;
  parseVenuePriceMajor = venue.parseVenuePriceMajor;
  formatVenuePriceMajorLabel = venue.formatVenuePriceMajorLabel;
  VENUE_PRICE_RANGE_STEP = venue.VENUE_PRICE_RANGE_STEP;
  VENUE_PRICE_RANGE_MAX = venue.VENUE_PRICE_RANGE_MAX;

  const transitions = (await import(
    new URL("../src/features/event/nextEventStatuses.ts", import.meta.url).href
  )) as { nextEventStatuses: typeof nextEventStatuses };
  nextEventStatuses = transitions.nextEventStatuses;

  const search = (await import(
    new URL("../src/features/participants/search.ts", import.meta.url).href
  )) as {
    compareParticipantsByName: typeof compareParticipantsByName;
    matchesParticipantQuery: typeof matchesParticipantQuery;
  };
  compareParticipantsByName = search.compareParticipantsByName;
  matchesParticipantQuery = search.matchesParticipantQuery;

  const autocomplete = (await import(
    new URL("../src/features/event/googlePlacePrediction.ts", import.meta.url)
      .href
  )) as {
    selectionFromPrediction: typeof selectionFromPrediction;
    selectionFromPlaceDetails: typeof selectionFromPlaceDetails;
  };
  selectionFromPrediction = autocomplete.selectionFromPrediction;
  selectionFromPlaceDetails = autocomplete.selectionFromPlaceDetails;
});

describe("event status vocabulary", () => {
  it("labels every status and never leaves colour to carry the meaning", () => {
    for (const status of ALL_STATUSES) {
      expect(eventStatusLabel(status)).not.toBe("");
      expect(eventStatusLabel(status)).not.toBe(status);
    }
  });

  it("gives each status its own chip colour", () => {
    const colours = ALL_STATUSES.map(eventStatusColor);
    expect(new Set(colours).size).toBe(ALL_STATUSES.length);
  });

  it("names every reachable transition as the act, not the destination", () => {
    for (const status of ALL_STATUSES) {
      for (const target of nextEventStatuses(status)) {
        expect(eventTransitionLabel(target)).not.toBe(eventStatusLabel(target));
      }
    }
    expect(eventTransitionLabel("cancelled")).toBe("Cancel event");
    expect(eventTransitionLabel("finished")).toBe("Mark finished");
  });

  it("mirrors the backend's edit and insert gates", () => {
    expect(isEventEditable("draft")).toBe(true);
    expect(isEventEditable("scheduled")).toBe(true);
    expect(isEventEditable("finished")).toBe(false);
    expect(isEventEditable("cancelled")).toBe(false);

    // Late adds survive «finished»; only a cancelled event refuses them.
    expect(acceptsNewAttendees("finished")).toBe(true);
    expect(acceptsNewAttendees("cancelled")).toBe(false);

    // Location context may be corrected after the dinner, but a cancelled
    // event remains frozen.
    expect(isEventVenueEditable("finished")).toBe(true);
    expect(isEventVenueEditable("cancelled")).toBe(false);
  });
});

describe("event venue helpers", () => {
  it("builds a free Maps deep-link from persisted data", () => {
    const url = new URL(
      googleMapsPlaceUrl({
        label: "Το μαγαζί & wine bar",
        placeId: "ChIJN1t_tDeuEmsRUsoyG83frY4",
      }),
    );

    expect(url.origin).toBe("https://www.google.com");
    expect(url.pathname).toBe("/maps/search/");
    expect(url.searchParams.get("api")).toBe("1");
    expect(url.searchParams.get("query")).toBe("Το μαγαζί & wine bar");
    expect(url.searchParams.get("query_place_id")).toBe(
      "ChIJN1t_tDeuEmsRUsoyG83frY4",
    );
  });

  it("converts operator-facing major currency units to stored minor units", () => {
    expect(venueMajorToMinor("35.50", "EUR")).toBe(3550);
    expect(venueMajorToMinor("3500", "JPY")).toBe(3500);
    expect(venueMajorToMinor("-1", "EUR")).toBeNull();
    expect(venueMajorToMinor("nonsense", "EUR")).toBeNull();
  });

  it("snaps typical price-range majors to the dual-thumb slider step", () => {
    expect(VENUE_PRICE_RANGE_STEP).toBe(5);
    expect(VENUE_PRICE_RANGE_MAX).toBe(150);
    expect(snapVenuePriceMajor(37)).toBe(35);
    expect(snapVenuePriceMajor(38)).toBe(40);
    expect(snapVenuePriceMajor(200)).toBe(150);
    expect(parseVenuePriceMajor("")).toBeNull();
    expect(parseVenuePriceMajor("42")).toBe(40);
    expect(formatVenuePriceMajorLabel(35, "EUR")).toContain("35");
  });

  it("maps autocomplete prediction fields as a details fallback", () => {
    expect(
      selectionFromPrediction({
        placeId: "ChIJ-prediction",
        mainText: { text: "  Six Dogs  " },
        secondaryText: { text: "  Monastiraki, Athens  " },
        text: { text: "Six Dogs, Monastiraki, Athens" },
        types: ["food", "night_club", "point_of_interest", "establishment"],
      }),
    ).toEqual({
      placeId: "ChIJ-prediction",
      label: "Six Dogs",
      area: "Monastiraki, Athens",
      type: "Night club",
    });

    expect(
      selectionFromPrediction({
        placeId: "ChIJ-generic",
        mainText: null,
        secondaryText: null,
        text: { text: "Fallback prediction text" },
        types: ["point_of_interest", "establishment"],
      }),
    ).toEqual({
      placeId: "ChIJ-generic",
      label: "Fallback prediction text",
      area: "",
      type: "",
    });
  });

  it("prefers canonical details over an alternative query spelling", () => {
    expect(
      selectionFromPlaceDetails(
        {
          placeId: "ChIJ-teras",
          mainText: { text: "τερας" },
          secondaryText: { text: "Theodoritou Vresthenis, Athens" },
          text: { text: "τερας, Theodoritou Vresthenis, Athens" },
          types: ["bar", "point_of_interest", "establishment"],
        },
        {
          displayName: " Teras Athens ",
          formattedAddress: " Theodoritou Vresthenis 45, Athens ",
          primaryTypeDisplayName: " Cocktail bar ",
        },
      ),
    ).toEqual({
      placeId: "ChIJ-teras",
      label: "Teras Athens",
      area: "Theodoritou Vresthenis 45, Athens",
      type: "Cocktail bar",
    });
  });

  it("keeps prediction fallbacks when canonical details are blank", () => {
    expect(
      selectionFromPlaceDetails(
        {
          placeId: "ChIJ-fallback",
          mainText: { text: "Six Dogs" },
          secondaryText: { text: "Monastiraki, Athens" },
          text: { text: "Six Dogs, Monastiraki, Athens" },
          types: ["night_club", "point_of_interest"],
        },
        {
          displayName: " ",
          formattedAddress: null,
          primaryTypeDisplayName: undefined,
        },
      ),
    ).toEqual({
      placeId: "ChIJ-fallback",
      label: "Six Dogs",
      area: "Monastiraki, Athens",
      type: "Night club",
    });
  });
});

describe("participant search", () => {
  const akis = {
    preferredName: "Άκης Στοποπερίεργος",
    emailNormalized: "akis@example.com",
    phoneE164: "+30690000404",
  };
  const maria = {
    preferredName: "Maria Papadopoulou",
    emailNormalized: "maria.p@example.com",
    phoneE164: null,
  };

  it("finds a Greek name typed without its tonos, in any case", () => {
    expect(matchesParticipantQuery(akis, "ακης")).toBe(true);
    expect(matchesParticipantQuery(akis, "ΆΚΗΣ")).toBe(true);
    expect(matchesParticipantQuery(akis, "Στοπο")).toBe(true);
  });

  it("narrows as terms are added rather than widening", () => {
    expect(matchesParticipantQuery(maria, "maria")).toBe(true);
    expect(matchesParticipantQuery(maria, "maria pap")).toBe(true);
    expect(matchesParticipantQuery(maria, "maria stopo")).toBe(false);
  });

  it("searches the email and the phone too, and keeps everyone on an empty query", () => {
    expect(matchesParticipantQuery(maria, "example.com")).toBe(true);
    expect(matchesParticipantQuery(akis, "690000404")).toBe(true);
    expect(matchesParticipantQuery(maria, "690000404")).toBe(false);
    expect(matchesParticipantQuery(maria, "   ")).toBe(true);
  });

  it("falls back to the email when someone has no name", () => {
    const nameless = {
      preferredName: null,
      emailNormalized: "zzz@example.com",
      phoneE164: null,
    };
    expect(matchesParticipantQuery(nameless, "zzz")).toBe(true);
    expect(compareParticipantsByName(maria, nameless)).toBeLessThan(0);
  });
});

describe("event screens", () => {
  it("adds attendees through the searchable picker, not a select of everyone", () => {
    const detail = readAdminFile("src/routes/EventDetailPage.tsx");
    const picker = readAdminFile(
      "src/components/admin/events/AddAttendeeAction.tsx",
    );

    expect(detail).toContain("AddAttendeeAction");
    expect(detail).not.toContain("<select");
    expect(picker).toContain("matchesParticipantQuery");
    expect(picker).toContain("SearchField");
  });

  it("shows the table as a read-only chip, leaving seating to its own area", () => {
    const detail = readAdminFile("src/routes/EventDetailPage.tsx");

    expect(detail).toContain("Table {row.original.tableNo}");
    // The bare per-row number field is what the chip replaced.
    expect(detail).not.toContain('type="number"');
    expect(detail).not.toContain("tableNo: number | null");
  });

  it("creates events from a dialog and states each status as a chip", () => {
    const list = readAdminFile("src/routes/EventsPage.tsx");

    expect(list).toContain("CreateEventAction");
    expect(list).toContain("EventStatusChip");
    expect(list).not.toContain("<form");
  });

  it("keeps venue editing independent and Google media display-only", () => {
    const detail = readAdminFile("src/routes/EventDetailPage.tsx");
    const card = readAdminFile(
      "src/components/admin/events/EventVenueCard.tsx",
    );
    const autocomplete = readAdminFile(
      "src/components/admin/events/GooglePlaceAutocomplete.tsx",
    );
    const googleDetails = readAdminFile(
      "src/components/admin/events/GooglePlaceDetails.tsx",
    );
    const googleSelection = readAdminFile(
      "src/components/admin/events/VenueGoogleSelection.tsx",
    );
    const googlePlaces = readAdminFile("src/lib/googlePlaces.ts");
    const googlePrediction = readAdminFile(
      "src/features/event/googlePlacePrediction.ts",
    );
    const feature = readAdminFile("src/features/event/venue.ts");

    expect(detail).toContain("isEventVenueEditable");
    expect(detail.indexOf("<EventVenueCard")).toBeLessThan(
      detail.indexOf("{isEventEditable"),
    );
    expect(card).toContain("Use venue context in Luna");
    expect(card).toContain("useInFeedback: venue?.useInFeedback ?? true");
    expect(card).toContain("<Modal");
    expect(card).toContain(
      'const [previewPlaceId, setPreviewPlaceId] = useState("")',
    );
    expect(card).toContain("isPending || googleLookupPending");
    expect(card).toContain('"Loading venue…"');
    expect(card).toContain("{isOpen ? (");
    expect(card).toContain("<Slider");
    expect(card).toContain("index={0}");
    expect(card).toContain("index={1}");
    expect(card).toContain("VENUE_PRICE_RANGE_STEP");
    expect(card).toContain("VENUE_PRICE_CURRENCY");
    expect(card).not.toContain("priceRangeEnabled");
    expect(card).not.toContain("GooglePlaceDetails");
    expect(card).not.toContain("GooglePlaceAutocomplete");
    expect(autocomplete).toContain("PlaceAutocompleteElement");
    expect(autocomplete).not.toContain("BasicPlaceAutocompleteElement");
    expect(autocomplete).toContain('includedRegionCodes: ["gr"]');
    expect(autocomplete).toContain("jts-google-place-autocomplete");
    expect(autocomplete).toContain("useTheme");
    expect(autocomplete).toContain("colorScheme");
    expect(autocomplete).toContain("new Place({ id: prediction.placeId })");
    expect(autocomplete).toContain("fetchFields");
    expect(autocomplete.match(/\.fetchFields\(/g)).toHaveLength(1);
    expect(autocomplete).toContain('"displayName"');
    expect(autocomplete).toContain('"formattedAddress"');
    expect(autocomplete).toContain('"primaryTypeDisplayName"');
    expect(autocomplete).not.toContain("prediction.toPlace()");
    expect(autocomplete).toContain("event.placePrediction");
    expect(autocomplete).toContain(
      "Canonical name, address and type filled below — review before saving.",
    );
    expect(autocomplete).toContain(
      "One details lookup runs only after selection",
    );
    expect(autocomplete).toContain("selectionRevision");
    expect(googlePrediction).toContain("prediction.mainText");
    expect(googlePrediction).toContain("prediction.secondaryText");
    expect(googlePrediction).toContain("readablePlaceType(prediction.types)");
    expect(googlePrediction).toContain("selectionFromPlaceDetails");
    expect(autocomplete).toContain("javascript/demo-key");
    expect(autocomplete).toContain("GOOGLE_PLACES_CONFIGURATION_ERROR_MESSAGE");
    expect(googleSelection).toContain("<GooglePlaceAutocomplete");
    expect(googleSelection).toContain("onPlaceSelect={onPlaceSelect}");
    expect(googleSelection).toContain(
      "onLookupPendingChange={onLookupPendingChange}",
    );
    expect(googleSelection).toContain("<GooglePlaceDetails");
    expect(googleSelection).toContain("<details");
    expect(googleSelection).toContain("Preview");
    expect(googleSelection).toContain("Find place");
    expect(googleSelection).toContain("Place ID");
    expect(googleDetails).toContain("PlaceDetailsCompactElement");
    expect(googleDetails).toContain("PlaceStandardContentElement");
    expect(googleDetails).toContain('"gmp-error"');
    expect(googleDetails).toContain(': "embed"');
    expect(googleDetails).toContain("<iframe");
    expect(googleDetails).toContain("googleMapsEmbedPlaceUrl");
    expect(googleDetails).toContain(
      "GOOGLE_PLACES_CONFIGURATION_ERROR_MESSAGE",
    );
    expect(googleDetails).not.toContain("fetchFields");
    expect(googlePlaces).toContain(
      'new URL("https://www.google.com/maps/embed/v1/place")',
    );
    expect(googlePlaces).toContain("q: `place_id:${trimmedPlaceId}`");
    expect(googlePlaces).toContain("Google venue request failed");
    expect(googlePlaces).toContain("project-level API enablement");
    expect(googlePlaces).toContain("allowed HTTP referrers");
    expect(card).toContain("label: selection.label");
    expect(card).toContain("area: selection.area");
    expect(card).toContain("type: selection.type");
    expect(feature).toContain("EventDetailDtoOutputVenue");
    expect(feature).toContain("UpdateEventDtoVenue");

    for (const source of [card, autocomplete, googleDetails, googleSelection]) {
      expect(source).not.toContain("photoUrl");
      expect(source).not.toContain("coverUrl");
    }
  });

  it("renders venue links in repeated rows without a Places API dependency", () => {
    const list = readAdminFile("src/routes/EventsPage.tsx");
    const profile = readAdminFile("src/routes/ParticipantProfilePage.tsx");
    const pill = readAdminFile("src/components/admin/events/VenuePill.tsx");
    const display = readAdminFile(
      "src/components/admin/events/VenueDisplay.tsx",
    );

    expect(list).toContain("<VenuePill");
    expect(profile).toContain("<VenuePill");
    expect(pill).toContain("googleMapsPlaceUrl");
    expect(pill).not.toContain("GooglePlaceDetails");
    expect(pill).not.toContain("loadGooglePlaces");
    expect(display).toContain("export function VenueCompact");
    expect(display).toContain("googleMapsPlaceUrl");
    expect(display.match(/<MapPin/g)).toHaveLength(1);
    expect(display).not.toContain("GooglePlaceDetails");
    expect(display).not.toContain("loadGooglePlaces");
    expect(list).not.toContain("GooglePlaceDetails");
    expect(profile).not.toContain("GooglePlaceDetails");
  });

  it("gives the long participant list a search and a paginator", () => {
    const participants = readAdminFile("src/routes/ParticipantsPage.tsx");

    expect(participants).toContain("SearchField");
    expect(participants).toContain("paginator");
    expect(participants).toContain("matchesParticipantQuery");
  });
});
