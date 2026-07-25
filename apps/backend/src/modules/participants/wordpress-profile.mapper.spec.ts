import { describe, expect, it } from "vitest";

import type { WordpressProfileExportRow } from "./wordpress-profile-import.schemas.js";
import {
  isCanonicalParticipantProfileComplete,
  mapWordpressProfile,
} from "./wordpress-profile.mapper.js";

function profileRow(
  answers: Partial<WordpressProfileExportRow["answers"]> = {},
): WordpressProfileExportRow {
  return {
    sourceProfileId: 42,
    sourceUserId: 7,
    sourceStatus: "publish",
    sourceUpdatedAt: "2026-07-22T12:00:00+00:00",
    answers: {
      name: "  Γιάννης   Δοκιμή  ",
      age: "25–34",
      telephone: "696 969 6969",
      city: "Κολωνάκι",
      interests: ["Ταξίδια", "Τεχνολογία"],
      personality: "3",
      email: " TEST@Example.GR ",
      ...answers,
    },
  };
}

describe("mapWordpressProfile", () => {
  it("maps the live WordPress labels into canonical participant values", () => {
    const result = mapWordpressProfile(profileRow());

    expect(result).toMatchObject({
      ok: true,
      value: {
        sourceProfileId: "42",
        sourceUserId: "7",
        profile: {
          preferredName: "Γιάννης Δοκιμή",
          ageBand: "25_34",
          phoneE164: "+306969696969",
          preferredNeighborhood: "kolonaki",
          interests: ["travel", "technology"],
          conversationStyle: 3,
          emailNormalized: "test@example.gr",
        },
      },
    });
    expect(result.ok && result.value.payloadHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    ["18–24", "18_24"],
    ["25–34", "25_34"],
    ["35–44", "35_44"],
    ["45–54", "45_54"],
    ["55+", "55_plus"],
  ])("maps age label %s", (label, expected) => {
    const result = mapWordpressProfile(profileRow({ age: label }));
    expect(result.ok && result.value.profile.ageBand).toBe(expected);
  });

  it.each([
    ["Κολωνάκι", "kolonaki"],
    ["Κουκάκι", "koukaki"],
    ["Εξάρχεια", "exarcheia"],
    ["Παγκράτι", "pangrati"],
    ["Γλυφάδα", "glyfada"],
    ["Χαλάνδρι", "chalandri"],
    ["Ψυρρή", "psyrri"],
    ["Νέα Σμύρνη", "nea_smyrni"],
    ["Μαρούσι", "marousi"],
    ["Πετράλωνα", "petralona"],
  ])("maps neighborhood label %s", (label, expected) => {
    const result = mapWordpressProfile(profileRow({ city: label }));
    expect(result.ok && result.value.profile.preferredNeighborhood).toBe(
      expected,
    );
  });

  it.each([
    ["Ταξίδια", "travel"],
    ["Μαγειρική & φαγητό", "cooking_food"],
    ["Τέχνη & μουσική", "art_music"],
    ["Αθλητισμός", "sports"],
    ["Τεχνολογία", "technology"],
    ["Βιβλία", "books"],
    ["Κινηματογράφος", "cinema"],
    ["Επιχειρηματικότητα", "entrepreneurship"],
    ["Φύση & εξωτερικές δραστηριότητες", "nature_outdoors"],
    ["Επιτραπέζια & παιχνίδια", "board_games"],
  ])("maps interest label %s", (label, expected) => {
    const result = mapWordpressProfile(profileRow({ interests: [label] }));
    expect(result.ok && result.value.profile.interests).toEqual([expected]);
  });

  it.each([
    ["+30 696 969 6969", "+306969696969"],
    ["0030 696 969 6969", "+306969696969"],
    ["306969696969", "+306969696969"],
    ["6969696969", "+306969696969"],
  ])("normalizes supported phone %s", (telephone, expected) => {
    const result = mapWordpressProfile(profileRow({ telephone }));
    expect(result.ok && result.value.profile.phoneE164).toBe(expected);
  });

  it("rejects the misleading zero value returned by the legacy API metadata", () => {
    const result = mapWordpressProfile(profileRow({ personality: 0 }));

    expect(result).toMatchObject({
      ok: false,
      code: "invalid_profile",
    });
  });

  it("preserves an incomplete legacy profile without inventing answers", () => {
    const result = mapWordpressProfile(
      profileRow({
        name: "",
        age: "",
        telephone: "",
        city: "",
        interests: [],
        personality: "",
      }),
    );

    expect(result.ok && result.value.profile).toEqual({
      preferredName: null,
      emailNormalized: "test@example.gr",
      phoneE164: null,
      ageBand: null,
      preferredNeighborhood: null,
      conversationStyle: null,
      interests: [],
    });
    expect(
      result.ok && isCanonicalParticipantProfileComplete(result.value.profile),
    ).toBe(false);
  });

  it("rejects unknown or excessive interests instead of silently coercing them", () => {
    const unknown = mapWordpressProfile(
      profileRow({ interests: ["Ταξίδια", "Άγνωστο"] }),
    );
    const excessive = mapWordpressProfile(
      profileRow({
        interests: [
          "Ταξίδια",
          "Μαγειρική & φαγητό",
          "Τέχνη & μουσική",
          "Αθλητισμός",
          "Τεχνολογία",
          "Βιβλία",
        ],
      }),
    );

    expect(unknown.ok).toBe(false);
    expect(excessive.ok).toBe(false);
  });
});
