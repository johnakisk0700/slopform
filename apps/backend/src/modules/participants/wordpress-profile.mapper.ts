import { createHash } from "node:crypto";

import {
  PARTICIPANT_AGE_BANDS,
  PARTICIPANT_INTERESTS,
  PARTICIPANT_NEIGHBORHOODS,
  type ParticipantInterestRow,
  type ParticipantRow,
} from "@join-the-six/database";

import {
  canonicalParticipantProfileSchema,
  type CanonicalParticipantProfile,
  type WordpressProfileExportRow,
  type WordpressProfileMappingResult,
} from "./wordpress-profile-import.schemas.js";

type ParticipantAgeBand = (typeof PARTICIPANT_AGE_BANDS)[number];
type ParticipantInterest = (typeof PARTICIPANT_INTERESTS)[number];
type ParticipantNeighborhood = (typeof PARTICIPANT_NEIGHBORHOODS)[number];

const AGE_BAND_BY_LABEL = new Map<string, ParticipantAgeBand>([
  ["18-24", "18_24"],
  ["25-34", "25_34"],
  ["35-44", "35_44"],
  ["45-54", "45_54"],
  ["55+", "55_plus"],
]);

const NEIGHBORHOOD_BY_LABEL = new Map<string, ParticipantNeighborhood>([
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
]);

const INTEREST_BY_LABEL = new Map<string, ParticipantInterest>([
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
]);

const INTEREST_ORDER = new Map<ParticipantInterest, number>(
  PARTICIPANT_INTERESTS.map((interest, index) => [interest, index]),
);

function normalizedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.normalize("NFC").trim().replace(/\s+/g, " ");
  return normalized || undefined;
}

function isBlank(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    (typeof value === "string" && normalizedString(value) === undefined)
  );
}

function normalizeOptional<T>(
  value: unknown,
  normalize: (candidate: unknown) => T | undefined,
): T | null | undefined {
  return isBlank(value) ? null : normalize(value);
}

function normalizeAgeBand(value: unknown): ParticipantAgeBand | undefined {
  const label = normalizedString(value)?.replace(/[‐‑‒–—−]/g, "-");
  return label ? AGE_BAND_BY_LABEL.get(label) : undefined;
}

function normalizePhone(value: unknown): string | undefined {
  const raw = normalizedString(value);

  if (!raw || /[^0-9+().\s-]/.test(raw)) {
    return undefined;
  }

  const compact = raw.replace(/[().\s-]/g, "");
  let e164: string;

  if (compact.startsWith("+")) {
    e164 = compact;
  } else if (compact.startsWith("00")) {
    e164 = `+${compact.slice(2)}`;
  } else if (/^30[26][0-9]{9}$/.test(compact)) {
    e164 = `+${compact}`;
  } else if (/^[26][0-9]{9}$/.test(compact)) {
    e164 = `+30${compact}`;
  } else if (/^0[26][0-9]{9}$/.test(compact)) {
    e164 = `+30${compact.slice(1)}`;
  } else {
    return undefined;
  }

  return /^\+[1-9][0-9]{7,14}$/.test(e164) ? e164 : undefined;
}

function normalizeConversationStyle(value: unknown): number | undefined {
  const parsed =
    typeof value === "number" ? value : Number(normalizedString(value));
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 5
    ? parsed
    : undefined;
}

function normalizeInterests(value: unknown): ParticipantInterest[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const mapped = value.map((item) => {
    const label = normalizedString(item);
    return label ? INTEREST_BY_LABEL.get(label) : undefined;
  });

  if (mapped.some((interest) => !interest)) {
    return undefined;
  }

  return [...new Set(mapped as ParticipantInterest[])].sort(
    (left, right) =>
      (INTEREST_ORDER.get(left) ?? 0) - (INTEREST_ORDER.get(right) ?? 0),
  );
}

function normalizeEmail(value: unknown): string | undefined {
  return normalizedString(value)?.toLowerCase();
}

function formatIssue(path: readonly PropertyKey[], message: string): string {
  const location = path.length > 0 ? path.join(".") : "profile";
  return `${location}: ${message}`;
}

export function mapWordpressProfile(
  row: WordpressProfileExportRow,
): WordpressProfileMappingResult {
  const sourceProfileId = String(row.sourceProfileId).trim();
  const candidate = {
    preferredName: normalizeOptional(row.answers.name, normalizedString),
    emailNormalized: normalizeEmail(row.answers.email),
    phoneE164: normalizeOptional(row.answers.telephone, normalizePhone),
    ageBand: normalizeOptional(row.answers.age, normalizeAgeBand),
    preferredNeighborhood: normalizeOptional(row.answers.city, (value) => {
      const label = normalizedString(value);
      return label ? NEIGHBORHOOD_BY_LABEL.get(label) : undefined;
    }),
    conversationStyle: normalizeOptional(
      row.answers.personality,
      normalizeConversationStyle,
    ),
    interests: normalizeInterests(row.answers.interests),
  };
  const parsed = canonicalParticipantProfileSchema.safeParse(candidate);

  if (!sourceProfileId || !parsed.success) {
    const issues = parsed.success
      ? ["sourceProfileId: must not be empty"]
      : parsed.error.issues.map((issue) =>
          formatIssue(issue.path, issue.message),
        );

    return {
      ok: false,
      sourceProfileId: sourceProfileId || "<empty>",
      code: "invalid_profile",
      issues,
    };
  }

  const payloadHash = createHash("sha256")
    .update(JSON.stringify(parsed.data))
    .digest("hex");
  const sourceUserId =
    row.sourceUserId === null || row.sourceUserId === undefined
      ? undefined
      : String(row.sourceUserId).trim() || undefined;

  return {
    ok: true,
    value: {
      sourceProfileId,
      ...(sourceUserId ? { sourceUserId } : {}),
      ...(row.sourceUpdatedAt
        ? { sourceUpdatedAt: new Date(row.sourceUpdatedAt) }
        : {}),
      payloadHash,
      profile: parsed.data,
    },
  };
}

export function participantMatchesProfile(
  participant: ParticipantRow,
  interests: readonly ParticipantInterestRow[],
  profile: CanonicalParticipantProfile,
): boolean {
  const persistedInterests = interests
    .map((item) => item.interest)
    .sort((left, right) => left.localeCompare(right));
  const incomingInterests = [...profile.interests].sort((left, right) =>
    left.localeCompare(right),
  );

  return (
    participant.preferredName === profile.preferredName &&
    participant.emailNormalized === profile.emailNormalized &&
    participant.phoneE164 === profile.phoneE164 &&
    participant.ageBand === profile.ageBand &&
    participant.preferredNeighborhood === profile.preferredNeighborhood &&
    participant.conversationStyle === profile.conversationStyle &&
    JSON.stringify(persistedInterests) === JSON.stringify(incomingInterests)
  );
}

export function isCanonicalParticipantProfileComplete(
  profile: CanonicalParticipantProfile,
): boolean {
  return (
    profile.preferredName !== null &&
    profile.phoneE164 !== null &&
    profile.ageBand !== null &&
    profile.preferredNeighborhood !== null &&
    profile.conversationStyle !== null &&
    profile.interests.length > 0
  );
}
