import { describe, expect, it } from "vitest";

import {
  acceptsNewAttendees,
  isEventEditable,
  isEventVenueEditable,
} from "../src/features/event/eventStatus";
import {
  selectionFromPlaceDetails,
  selectionFromPrediction,
} from "../src/features/event/googlePlacePrediction";
import {
  googleMapsPlaceUrl,
  venueMajorToMinor,
} from "../src/features/event/venue";
import {
  compareParticipantsByName,
  matchesParticipantQuery,
} from "../src/features/participants/search";

describe("event status rules", () => {
  it("keeps edit and attendee rules explicit at terminal states", () => {
    expect(isEventEditable("draft")).toBe(true);
    expect(isEventEditable("scheduled")).toBe(true);
    expect(isEventEditable("finished")).toBe(false);
    expect(isEventEditable("cancelled")).toBe(false);
    expect(acceptsNewAttendees("finished")).toBe(true);
    expect(acceptsNewAttendees("cancelled")).toBe(false);
    expect(isEventVenueEditable("finished")).toBe(true);
    expect(isEventVenueEditable("cancelled")).toBe(false);
  });
});

describe("venue helpers", () => {
  it("builds a Maps deep link from persisted venue data", () => {
    const url = new URL(
      googleMapsPlaceUrl({
        label: "Το μαγαζί & wine bar",
        placeId: "ChIJN1t_tDeuEmsRUsoyG83frY4",
      }),
    );

    expect(url.origin).toBe("https://www.google.com");
    expect(url.pathname).toBe("/maps/search/");
    expect(url.searchParams.get("query")).toBe("Το μαγαζί & wine bar");
    expect(url.searchParams.get("query_place_id")).toBe(
      "ChIJN1t_tDeuEmsRUsoyG83frY4",
    );
  });

  it("converts non-negative major currency units to minor units", () => {
    expect(venueMajorToMinor("35.50", "EUR")).toBe(3550);
    expect(venueMajorToMinor("3500", "JPY")).toBe(3500);
    expect(venueMajorToMinor("-1", "EUR")).toBeNull();
    expect(venueMajorToMinor("nonsense", "EUR")).toBeNull();
  });
});

describe("Google Places selection", () => {
  it("uses prediction text when no canonical details are available", () => {
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

  it("prefers canonical details and keeps prediction fallbacks", () => {
    const prediction = {
      placeId: "ChIJ-teras",
      mainText: { text: "τερας" },
      secondaryText: { text: "Theodoritou Vresthenis, Athens" },
      text: { text: "τερας, Theodoritou Vresthenis, Athens" },
      types: ["bar", "point_of_interest", "establishment"],
    };

    expect(
      selectionFromPlaceDetails(prediction, {
        displayName: " Teras Athens ",
        formattedAddress: " Theodoritou Vresthenis 45, Athens ",
        primaryTypeDisplayName: " Cocktail bar ",
      }),
    ).toEqual({
      placeId: "ChIJ-teras",
      label: "Teras Athens",
      area: "Theodoritou Vresthenis 45, Athens",
      type: "Cocktail bar",
    });

    expect(
      selectionFromPlaceDetails(prediction, {
        displayName: " ",
        formattedAddress: null,
        primaryTypeDisplayName: undefined,
      }),
    ).toEqual({
      placeId: "ChIJ-teras",
      label: "τερας",
      area: "Theodoritou Vresthenis, Athens",
      type: "Bar",
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

  it("finds Greek names without tonos and narrows with more terms", () => {
    expect(matchesParticipantQuery(akis, "ακης")).toBe(true);
    expect(matchesParticipantQuery(akis, "ΆΚΗΣ Στοπο")).toBe(true);
    expect(matchesParticipantQuery(maria, "maria pap")).toBe(true);
    expect(matchesParticipantQuery(maria, "maria stopo")).toBe(false);
  });

  it("searches email and phone while keeping an empty query broad", () => {
    expect(matchesParticipantQuery(maria, "example.com")).toBe(true);
    expect(matchesParticipantQuery(akis, "690000404")).toBe(true);
    expect(matchesParticipantQuery(maria, "690000404")).toBe(false);
    expect(matchesParticipantQuery(maria, "   ")).toBe(true);
  });

  it("sorts by the name displayed to the operator", () => {
    const nameless = {
      preferredName: null,
      emailNormalized: "zzz@example.com",
      phoneE164: null,
    };
    expect(matchesParticipantQuery(nameless, "zzz")).toBe(true);
    expect(compareParticipantsByName(maria, nameless)).toBeLessThan(0);
  });
});
