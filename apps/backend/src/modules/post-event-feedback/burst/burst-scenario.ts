import type {
  FeedbackAnswerQuestionKey,
  FeedbackNoteType,
} from "@join-the-six/database";

import type {
  PostEventFeedbackRecommendedAction,
  PostEventFeedbackSafetyCategory,
} from "../attention.js";

/**
 * The shared contract for the multi-campaign burst rehearsal.
 *
 * The question the rehearsal answers is **not** throughput. It is whether the
 * loop stays correct when many people answer at once: no duplicate message
 * reaches a phone, no answer is written against the wrong conversation, and
 * every campaign reaches a terminal state without a human touching it.
 *
 * The campaigns run concurrently, six personas each when the catalogue is
 * complete. A persona is named after the thing that makes it hard — `Κώστας
 * Αργοπληκτρολογάκιας` types slowly, `Μαρία Φλερτατζού` flirts — so the admin
 * conversation list reads as the scenario catalogue and a failure is
 * identifiable without cross-referencing a table. That naming is load-bearing,
 * not decoration: the display name is the only scenario label that survives
 * into MongoDB, the outbox and the report.
 *
 * Every dinner past the third exists so the table stays a Six: growing an
 * existing campaign would rewrite every persona's candidate list in it, and the
 * candidate list is the input extraction is measured on. `mezedopoleio` and
 * `ouzeri` are those campaigns. Nothing here counts campaigns or personas by
 * hand — the runner, the catalog endpoint and the response bound all derive
 * from `BURST_CAMPAIGNS.length` and `BURST_PERSONAS.length`, so a sixth dinner
 * costs one entry in each list.
 *
 * This file holds types and identifiers only. The personas live in
 * `burst-personas.ts`, the deterministic model in
 * `scripted-extraction-model.service.ts`, and the runner in
 * `scripts/run-feedback-burst.mjs`.
 */

/** One campaign per dinner. The slug is the seed identity, not a display name. */
export const BURST_CAMPAIGN_SLUGS = [
  "taverna",
  "rooftop",
  "wine",
  "mezedopoleio",
  "ouzeri",
] as const;

export type BurstCampaignSlug = (typeof BURST_CAMPAIGN_SLUGS)[number];

export interface BurstCampaignDefinition {
  readonly slug: BurstCampaignSlug;
  /** Ordinal from one, in catalogue order. Fixes the phone block and seeding. */
  readonly ordinal: number;
  /** Event title as it appears in the admin. */
  readonly title: string;
}

export const BURST_CAMPAIGNS: readonly BurstCampaignDefinition[] = [
  { slug: "taverna", ordinal: 1, title: "Δοκιμαστικό δείπνο — Ταβέρνα" },
  { slug: "rooftop", ordinal: 2, title: "Δοκιμαστικό δείπνο — Rooftop" },
  { slug: "wine", ordinal: 3, title: "Δοκιμαστικό δείπνο — Οινοποιείο" },
  {
    slug: "mezedopoleio",
    ordinal: 4,
    title: "Δοκιμαστικό δείπνο — Μεζεδοπωλείο",
  },
  { slug: "ouzeri", ordinal: 5, title: "Δοκιμαστικό δείπνο — Ουζερί" },
];

/** Six personas per campaign when the catalogue is full. */
export const BURST_PERSONAS_PER_CAMPAIGN = 6;

/**
 * Reserved phone block for the rehearsal: `+3069000<cc><pp>`, campaign ordinal
 * then persona ordinal, both two digits. Nothing else in the system may use
 * `+3069000…`, so a stray conversation is always identifiable as rehearsal data.
 */
export function burstPhoneE164(
  campaignOrdinal: number,
  personaOrdinal: number,
): string {
  const campaign = String(campaignOrdinal).padStart(2, "0");
  const persona = String(personaOrdinal).padStart(2, "0");
  return `+3069000${campaign}${persona}`;
}

/** One inbound WhatsApp message, relative to the persona's previous message. */
export interface BurstPersonaMessage {
  /** Delay after the previous message. The first message is always 0. */
  readonly afterMs: number;
  /**
   * `null` is a voice note, a photo or a reaction — an inbound the provider
   * hands us with no body at all.
   *
   * The same convention the single-conversation harness uses
   * (`post-event-feedback-loop-scenario.ts`). It is not a shorthand for "empty
   * string": the materializer treats a missing body as something it cannot turn
   * into testimony, which is a different path from any text we could read, and
   * a persona had no way to reach it while this field was a plain string.
   */
  readonly text: string | null;
}

/**
 * How a scripted proposal cites the messages it read.
 *
 * The same vocabulary the fake loop harness uses. A stub cannot know transcript
 * ids in advance, so it resolves these against the run's actual new-message list.
 */
export type BurstCitation = "all-new" | "last" | "first";

export interface BurstStubAnswer {
  readonly question: FeedbackAnswerQuestionKey;
  /** Integer questions only. */
  readonly value?: number;
  /** Directed questions only: a candidate display name, never an id. */
  readonly about?: string;
  readonly cite?: BurstCitation;
}

export interface BurstStubNote {
  readonly type: FeedbackNoteType;
  readonly text: string;
  /** A candidate display name, or omitted for a subjectless note. */
  readonly about?: string;
  /** The name as the participant wrote it, when it resolves to nobody. */
  readonly mentionedName?: string;
  readonly cite?: BurstCitation;
}

export interface BurstStubAttentionSignal {
  readonly categories: readonly PostEventFeedbackSafetyCategory[];
  readonly action: PostEventFeedbackRecommendedAction;
  /** Which of the run's new messages carries the signal. */
  readonly on: BurstCitation;
}

/**
 * What the deterministic model proposes on one extraction run.
 *
 * A persona declares one turn per extraction run it expects to cause. The stub
 * consumes them in order per conversation; running out means the persona caused
 * more runs than it claimed, which is itself a finding and must fail the
 * rehearsal rather than silently return an empty proposal.
 */
export interface BurstStubTurn {
  readonly answers?: readonly BurstStubAnswer[];
  readonly notes?: readonly BurstStubNote[];
  readonly skippedGoals?: readonly FeedbackAnswerQuestionKey[];
  readonly nextGoal?: FeedbackAnswerQuestionKey | null;
  readonly reply?: string | null;
  readonly handoff?: boolean;
  readonly confidence?: number;
  /** Signals the attention classifier returns for this run's new messages. */
  readonly attention?: readonly BurstStubAttentionSignal[];
}

export interface BurstExpectedAnswer {
  readonly question: FeedbackAnswerQuestionKey;
  /** Candidate display name for directed questions, `null` for `event_score`. */
  readonly about: string | null;
  readonly value: number | null;
}

/**
 * What must be true of this conversation when the rehearsal ends.
 *
 * Deliberately narrow. A rehearsal that asserts the model's wording is asserting
 * the wrong thing; what matters is that the mechanism recorded the right facts,
 * spoke the right number of times, and ended where it should.
 */
export interface BurstExpectedOutcome {
  readonly lifecycle: "open" | "closed";
  readonly closedBecause:
    "completed" | "stopped" | "expired" | "cancelled" | null;
  readonly optedIn: boolean;
  readonly answers: readonly BurstExpectedAnswer[];
  readonly needsAttention: boolean;
  /** Inclusive bounds on outbound messages that actually reached the phone. */
  readonly minReceived: number;
  readonly maxReceived: number;
}

export interface BurstPersona {
  /** Stable slug, lower snake case, unique across all campaigns. */
  readonly id: string;
  readonly campaign: BurstCampaignSlug;
  /** Ordinal 1-6 within its campaign. Fixes the phone and the seeding order. */
  readonly ordinal: number;
  readonly firstName: string;
  /** The quirk, as a surname. This is what makes the admin readable. */
  readonly lastName: string;
  /** One Greek sentence naming the hazard, for the report. */
  readonly quirk: string;
  /**
   * The scenario in `post-event-feedback-scenarios.md` this persona rehearses,
   * so a failure here points at an existing single-conversation contract.
   */
  readonly mirrors: string;
  readonly messages: readonly BurstPersonaMessage[];
  readonly stub: readonly BurstStubTurn[];
  readonly expect: BurstExpectedOutcome;
}

export function burstPersonaDisplayName(persona: BurstPersona): string {
  return `${persona.firstName} ${persona.lastName}`;
}

export function burstPersonaPhoneE164(persona: BurstPersona): string {
  const campaign = BURST_CAMPAIGNS.find(
    (definition) => definition.slug === persona.campaign,
  );
  if (!campaign) {
    throw new Error(`Persona ${persona.id} names an unknown campaign`);
  }
  return burstPhoneE164(campaign.ordinal, persona.ordinal);
}
