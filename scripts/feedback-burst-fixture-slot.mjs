/**
 * Non-destructive seed namespaces for the multi-campaign burst rehearsal.
 *
 * Slot 0 is the historical corpus exactly as published by the API. Slots 1–9
 * keep scenario identity (persona ids and campaign slugs) while moving every
 * database identity that would collide with a consumed run: participant phone,
 * participant email and event title.
 */

const FIXTURE_SLOT_PATTERN = /^[0-9]$/u;
const CANONICAL_PHONE_PREFIX = "+3069000";
const SLOTTED_PHONE_PREFIX = "+306900";
const E164_PATTERN = /^\+[1-9]\d{1,14}$/u;
const CAMPAIGN_SLUG_PATTERN = /^[a-z0-9-]+$/u;

/** Parse `--fixture-slot`, defaulting to the historical namespace. */
export function resolveFeedbackBurstFixtureSlot(value) {
  if (value === undefined) {
    return 0;
  }
  const text = String(value);
  if (!FIXTURE_SLOT_PATTERN.test(text)) {
    throw new Error("--fixture-slot must be one digit from 0 through 9");
  }
  return Number(text);
}

/**
 * The scripted extractor is published against slot 0 only. Paid extraction
 * understands the ordinary conversation state and can safely use a fresh slot.
 */
export function assertFeedbackBurstFixtureSlotMode({ fixtureSlot, stubMode }) {
  if (stubMode && fixtureSlot !== 0) {
    throw new Error(
      "--fixture-slot 1..9 requires --profile prova or --comparison qwen; deterministic stub mode is calibrated only for slot 0",
    );
  }
}

/**
 * Keep retained Redis failures from an older slot out of a fresh run's report.
 * Slot 0 preserves its legacy reason-only stub diagnostics; paid slots are
 * strictly scoped by their newly created conversation ids.
 */
export function feedbackBurstFailedJobBelongsToSlot({
  fixtureSlot,
  conversationId,
  currentConversationIds,
  failedReason,
}) {
  const slot = resolveFeedbackBurstFixtureSlot(fixtureSlot);
  if (
    typeof conversationId === "string" &&
    currentConversationIds.has(conversationId)
  ) {
    return true;
  }
  return (
    slot === 0 && /exhausted|Scripted burst persona/iu.test(failedReason ?? "")
  );
}

/** Deterministic participant email; slot 0 remains byte-for-byte compatible. */
export function feedbackBurstParticipantSeedEmail(persona, fixtureSlot) {
  const slot = resolveFeedbackBurstFixtureSlot(fixtureSlot);
  const campaign = String(persona?.campaign ?? "");
  const ordinal = persona?.ordinal;
  if (!CAMPAIGN_SLUG_PATTERN.test(campaign)) {
    throw new Error(
      `Burst persona ${String(persona?.id ?? "unknown")} has an unsafe campaign slug`,
    );
  }
  assertOrdinal(ordinal, `persona ${String(persona?.id ?? "unknown")}`);
  const seat = `${campaign}.${String(ordinal).padStart(2, "0")}`;
  return slot === 0
    ? `burst.${seat}@burst.jointhesix.local`
    : `burst.slot${slot}.${seat}@burst.jointhesix.local`;
}

/**
 * Clone the server catalogue into one fixture slot.
 *
 * The strict canonical-phone check makes catalogue drift fail before any seed
 * write. The uniqueness checks are intentionally redundant with database
 * constraints: discovering a collision after campaign launch is much too late.
 */
export function namespaceFeedbackBurstCatalog(catalog, fixtureSlot) {
  const slot = resolveFeedbackBurstFixtureSlot(fixtureSlot);
  if (!Array.isArray(catalog?.campaigns) || !Array.isArray(catalog?.personas)) {
    throw new Error("Burst catalogue must contain campaign and persona arrays");
  }

  const campaignSlugs = new Set();
  const campaignOrdinals = new Set();
  const eventTitles = new Set();
  const campaigns = catalog.campaigns.map((campaign) => {
    const slug = String(campaign?.slug ?? "");
    if (!CAMPAIGN_SLUG_PATTERN.test(slug)) {
      throw new Error(
        `Burst campaign has an unsafe slug: ${slug || "missing"}`,
      );
    }
    assertUnique(campaignSlugs, slug, "campaign slug");
    assertOrdinal(campaign.ordinal, `campaign ${slug}`);
    assertUnique(campaignOrdinals, campaign.ordinal, "campaign ordinal");
    if (typeof campaign.title !== "string" || campaign.title.length === 0) {
      throw new Error(`Burst campaign ${slug} has no title`);
    }
    const title =
      slot === 0 ? campaign.title : `${campaign.title} [burst slot ${slot}]`;
    if (title.length > 200) {
      throw new Error(
        `Burst campaign ${slug} slotted title exceeds 200 characters`,
      );
    }
    assertUnique(eventTitles, title, "event title");
    return { ...campaign, title };
  });

  const campaignBySlug = new Map(
    campaigns.map((campaign) => [campaign.slug, campaign]),
  );
  const personaIds = new Set();
  const phones = new Set();
  const emails = new Set();
  const personas = catalog.personas.map((persona) => {
    const id = String(persona?.id ?? "");
    if (id.length === 0) {
      throw new Error("Burst catalogue contains a persona without an id");
    }
    assertUnique(personaIds, id, "persona id");
    const campaign = campaignBySlug.get(persona.campaign);
    if (!campaign) {
      throw new Error(
        `Burst persona ${id} references unknown campaign ${String(persona.campaign)}`,
      );
    }
    assertOrdinal(persona.ordinal, `persona ${id}`);
    const campaignOrdinal = String(campaign.ordinal).padStart(2, "0");
    const personaOrdinal = String(persona.ordinal).padStart(2, "0");
    const canonicalPhone = `${CANONICAL_PHONE_PREFIX}${campaignOrdinal}${personaOrdinal}`;
    if (persona.phoneE164 !== canonicalPhone) {
      throw new Error(
        `Burst persona ${id} phone drifted: expected ${canonicalPhone}, received ${String(persona.phoneE164)}`,
      );
    }
    const phoneE164 = `${SLOTTED_PHONE_PREFIX}${slot}${campaignOrdinal}${personaOrdinal}`;
    if (!E164_PATTERN.test(phoneE164)) {
      throw new Error(
        `Burst persona ${id} produced invalid E.164 ${phoneE164}`,
      );
    }
    assertUnique(phones, phoneE164, "fixture phone");
    assertUnique(
      emails,
      feedbackBurstParticipantSeedEmail(persona, slot),
      "fixture participant email",
    );
    return { ...persona, phoneE164 };
  });

  return { ...catalog, campaigns, personas };
}

function assertOrdinal(value, owner) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 99) {
    throw new Error(
      `Burst ${owner} ordinal must be an integer from 1 through 99`,
    );
  }
}

function assertUnique(seen, value, label) {
  if (seen.has(value)) {
    throw new Error(`Burst catalogue has duplicate ${label}: ${String(value)}`);
  }
  seen.add(value);
}
