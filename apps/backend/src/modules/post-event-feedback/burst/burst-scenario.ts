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
  "zontanoi",
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
  {
    slug: "zontanoi",
    ordinal: 6,
    title: "Δοκιμαστικό δείπνο — Ζωντανοί καλεσμένοι",
  },
];

/**
 * Six personas per campaign when the catalogue is full — the product is called
 * Join The Six and a table is six people.
 *
 * `zontanoi` is six like the rest, but its guests are written live by a model
 * rather than by a script. It started as two, so that each guest was the other's
 * entire candidate list and a directed answer had exactly one name it could
 * possibly resolve to — name resolution deliberately out of scope while we found
 * out whether improvised guests worked at all. They do, so the table is a full
 * Six and resolution is back in scope on purpose: two of its first names are one
 * letter from another guest's, which no scripted table has, because a script
 * cannot mention somebody it was not written to mention.
 */
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
  /**
   * Present only for a guest whose replies are written by a model at run time
   * instead of being scripted. `messages` stays empty for those: there is no
   * script to send.
   *
   * Every other persona is a recording. It sends its third message whatever the
   * bot actually said — even if the bot asked something else, even if it said it
   * was stopping. So no amount of them can test the bot against somebody who
   * *reacts*, and two rules we rely on are unverifiable by a script for exactly
   * that reason: 11δ says never re-ask in the same words, and 11ζ says match the
   * register of the person writing. A script has no register to match and never
   * notices being repeated at.
   */
  readonly live?: BurstLiveGuest;
}

/**
 * A guest the harness improvises, by handing a character sheet and the running
 * transcript to a cheap model and injecting whatever it writes back.
 *
 * This is a one-shot generation, not an agent: no tools, no repository, one
 * short message. That is why `model` points at a Cursor `-fast` tier — the cost
 * is process startup, not thinking.
 */
export interface BurstLiveGuest {
  /** A `cursor-agent` model id. `cursor-agent models` is the source of truth. */
  readonly model: string;
  /** Who this person is, in Greek, as the character sheet the model is given. */
  readonly character: string;
  /**
   * How many times this guest will answer before going quiet.
   *
   * A live guest cannot be trusted to end a conversation — it will happily
   * chat past the questionnaire — and a rehearsal that never settles reports
   * failure for the whole campaign. The cap is what makes the run terminate.
   */
  readonly maxTurns: number;
}

export function burstPersonaDisplayName(persona: BurstPersona): string {
  return `${persona.firstName} ${persona.lastName}`;
}

/**
 * One persona as the catalogue endpoint publishes it.
 *
 * Lives here rather than inline in the controller because the schema spec used
 * to build its own copy of this mapping while calling itself "the catalogue the
 * controller builds". The two drifted the moment a persona gained a field, and
 * the test that existed to catch exactly that kind of drift passed anyway. One
 * function means the spec parses what the endpoint actually returns.
 *
 * The character sheet of a live guest is deliberately not published — only the
 * model id. It is the harness's own instruction, and in a report it would read
 * like something a participant said.
 */
export function burstPersonaCatalogEntry(persona: BurstPersona) {
  return {
    id: persona.id,
    campaign: persona.campaign,
    ordinal: persona.ordinal,
    displayName: burstPersonaDisplayName(persona),
    phoneE164: burstPersonaPhoneE164(persona),
    quirk: persona.quirk,
    mirrors: persona.mirrors,
    messages: persona.messages.map((message) => ({
      afterMs: message.afterMs,
      text: message.text,
    })),
    ...(persona.live ? { liveModel: persona.live.model } : {}),
    expect: persona.expect,
  };
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
