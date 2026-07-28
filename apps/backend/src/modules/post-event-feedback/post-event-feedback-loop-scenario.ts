import type {
  FeedbackAnswerQuestionKey,
  FeedbackNoteType,
} from "@join-the-six/database";
import type { FeedbackConversationGoal } from "./post-event-feedback-conversation.document.js";
import type {
  PostEventFeedbackRecommendedAction,
  PostEventFeedbackSafetyCategory,
} from "./attention.js";
import {
  FEEDBACK_EXTRACT_QUIET_WINDOW_MS,
  type FeedbackJobName,
} from "./jobs.schemas.js";

// ── Fixed identity ──────────────────────────────────────────────────────────
// Fixed rather than random so a failure is reproducible and a diff is readable.
// Scenarios never type any of these: names resolve to ids inside the harness.

export const CAMPAIGN_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
export const EVENT_ID = "5c2f0b8e-9b1a-4a41-8f27-1a6f9b0c2d10";
export const PERSON_IDS = [
  "9f3c1a52-6e2b-4b4a-9a17-2cb2a6d13a55",
  "1b0a2f1c-2d3e-4f50-8a91-0b2c3d4e5f60",
  "2c1b3a2d-3e4f-5061-9b02-1c3d4e5f6071",
  "3d2c4b3e-4f50-6172-8c13-2d4e5f607182",
  "4e3d5c4f-5061-7283-9d24-3e5f60718293",
  "5f4e6d50-6172-8394-8e35-4f60718293a4",
  "60517e61-7283-94a5-9f46-5071829304b5",
  "71628f72-8394-a5b6-8057-61829304b5c6",
] as const;

export const FEEDBACK_LOOP_START = new Date("2026-07-25T20:00:00.000Z");
export const DEFAULT_RESPONDENT = "Μαρία";
export const DEFAULT_PHONE = "+306900000001";
export const DEFAULT_CANDIDATES = [
  "Νίκος",
  "Ελένη",
  "Κώστας Π.",
  "Κώστας Γ.",
] as const;

export const RELAY_JOB_ID = "feedback-relay-outbox-v1";
export const MAX_DRAIN_STEPS = 100_000;
export const TEST_STAFF_ID = "staff-loop-harness";

// ── Durations ───────────────────────────────────────────────────────────────

/**
 * `"12s"`, `"3m"`, `"25h"`, `"4d"` — readable in a scenario table — plus one
 * symbolic duration, `"settles"`.
 *
 * **Use `"settles"` whenever the scenario means "long enough for the model to
 * read what was just said".** It resolves against the real quiet window, so
 * tuning that constant does not touch a single scenario. Writing `"20s"` for
 * that intent looks equivalent and is not: it silently couples the row to
 * today's value, and raising the window from 12s to 45s turned forty green rows
 * red at once for no behavioural reason.
 *
 * A literal duration is for scenarios where the *elapsed time itself* is the
 * subject — a reminder at 25h, a reply four days later, a burst typed at 2s
 * intervals.
 */
export type ScenarioDuration =
  | `${number}ms`
  | `${number}s`
  | `${number}m`
  | `${number}h`
  | `${number}d`
  | number
  | "settles";

const DURATION_UNITS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** Comfortably past the quiet window, whatever the window currently is. */
const SETTLES_MS = FEEDBACK_EXTRACT_QUIET_WINDOW_MS + 5_000;

export function parseDuration(duration: ScenarioDuration): number {
  if (typeof duration === "number") {
    return duration;
  }
  if (duration === "settles") {
    return SETTLES_MS;
  }
  const match = /^(?<value>\d+(?:\.\d+)?)(?<unit>ms|s|m|h|d)$/u.exec(duration);
  const value = match?.groups?.["value"];
  const unit = match?.groups?.["unit"];
  if (!value || !unit) {
    throw new Error(`Unreadable duration: ${duration}`);
  }
  return Number(value) * (DURATION_UNITS[unit] ?? 1);
}

// ── The scenario vocabulary ─────────────────────────────────────────────────

/**
 * Which transcript messages a scripted extraction cites.
 *
 * Scenario authors never see a generated id: a citation is a keyword, the exact
 * text of a participant message, or the 1-based position of a participant
 * message in the transcript. Keywords win over identical message text.
 */
export type Cite =
  /** Every participant message this run has not read yet. The default. */
  | "all-new"
  /** The newest participant message. */
  | "last"
  /** The newest bot message — for proving that bot turns are not testimony. */
  | "bot"
  | string
  | number
  | readonly (string | number)[];

export type ModelFailure =
  /** The provider's content filter declined. Retryable, so attempts exhaust. */
  | "refuses"
  /** A missing key or a hard rejection. Permanent — no retry, straight to the fallback. */
  | "unavailable"
  /** A timeout or a 5xx. Retryable. */
  | "times_out"
  /** A response that never satisfies the agreed schema. Retryable. */
  | "malformed";

export interface ScriptedAnswer {
  readonly question: FeedbackAnswerQuestionKey;
  /** Only `event_score` carries a value. */
  readonly value?: number;
  /** A display name. An unseeded name is one the model could not resolve. */
  readonly about?: string;
  readonly cite?: Cite;
  readonly confidence?: number;
}

export interface ScriptedNote {
  readonly type?: FeedbackNoteType;
  readonly text: string;
  readonly about?: string;
  readonly cite?: Cite;
  readonly confidence?: number;
}

export interface ScriptedAttention {
  readonly category: PostEventFeedbackSafetyCategory;
  readonly action: PostEventFeedbackRecommendedAction;
  readonly on?: Cite;
  readonly confidence?: number;
}

/**
 * One classification call's worth of output, when it says more than "these are
 * the signals".
 *
 * `hostileToUs` is a field of its own rather than a category in `signals`,
 * mirroring the classifier: a scenario able to express «he swore at us» only by
 * naming `other_safety` would be asserting the exact false positive the prompt
 * exists to prevent, and the suite would then pass while the product flagged
 * every crude joke as an incident.
 */
export interface ScriptedAttentionTurn {
  readonly signals?: readonly ScriptedAttention[];
  readonly hostileToUs?: boolean;
}

/**
 * One classification call's worth of signals. Empty means "nothing to flag".
 *
 * The bare-array form is the common case and stays the shorthand; the object
 * form is for a run that also has something to say about hostility.
 */
export type AttentionTurn =
  readonly ScriptedAttention[] | ScriptedAttentionTurn;

/** What the model does the next time it is asked to read the transcript. */
export interface ModelTurn {
  readonly answers?: readonly ScriptedAnswer[];
  readonly notes?: readonly ScriptedNote[];
  readonly skip?: readonly FeedbackAnswerQuestionKey[];
  readonly next?: FeedbackAnswerQuestionKey;
  readonly reply?: string;
  readonly handoff?: boolean;
  readonly confidence?: number;
  /** The provider throws instead of answering. */
  readonly fails?: ModelFailure;
}

export type FeedbackExternalAction =
  /** A WhatsApp message arrived. `text: null` is a voice note, photo or reaction. */
  | {
      readonly kind: "inbound";
      readonly text: string | null;
      /** Provider event time relative to scenario start; defaults to arrival time. */
      readonly observedAt?: ScenarioDuration;
      /** A different phone than the respondent's. */
      readonly from?: string;
      /** Reuse an id to replay a provider redelivery. */
      readonly providerMessageId?: string;
    }
  /** An outbound message was observed on the shared session. */
  | {
      readonly kind: "observed_outbound";
      readonly text: string;
      /** Provider event time relative to scenario start; defaults to arrival time. */
      readonly observedAt?: ScenarioDuration;
      readonly providerMessageId?: string;
    }
  /** An operator used the real staff-facing conversation service. */
  | {
      readonly kind: "staff";
      readonly action: "take_over" | "resume" | "close";
    }
  | {
      readonly kind: "staff";
      readonly action: "send";
      readonly text: string;
    }
  /** An upstream campaign lifecycle change reached the shared store. */
  | {
      readonly kind: "campaign";
      readonly status: "launched" | "paused" | "closed";
    }
  /** The participant's independently owned messaging consent changed. */
  | {
      readonly kind: "consent";
      readonly optedIn: boolean;
    }
  /** The next transport send returns this provider outcome. */
  | {
      readonly kind: "transport";
      readonly outcome: "accepted" | "not-accepted" | "unknown";
    };

export type FeedbackStep =
  | (FeedbackExternalAction & { readonly after?: ScenarioDuration })
  /** Time passed. Delayed extraction runs and the sweeps fire inside it. */
  | { readonly kind: "wait"; readonly after: ScenarioDuration }
  /**
   * Start advancing the worker clock, wait until the extraction provider call
   * is genuinely in flight, apply one external action, then release the call.
   * This is the race vocabulary; scenario code never reaches into the extractor.
   */
  | {
      readonly kind: "during_model";
      readonly after: ScenarioDuration;
      readonly action: FeedbackExternalAction;
    };

export interface FeedbackSeedOptions {
  readonly respondent?: string;
  readonly phone?: string;
  readonly candidates?: readonly string[];
  readonly optedIn?: boolean;
  readonly campaign?: "launched" | "paused" | "closed";
  readonly control?: "bot" | "human";
  /** Start from an already-closed conversation. */
  readonly closed?: "completed" | "stopped" | "expired" | "cancelled";
  readonly goals?: Partial<
    Record<FeedbackAnswerQuestionKey, FeedbackConversationGoal["status"]>
  >;
  /** Answers recorded before the scenario starts. */
  readonly answers?: readonly {
    readonly question: FeedbackAnswerQuestionKey;
    readonly about?: string;
    readonly value?: number;
  }[];
}

// ── The outcome snapshot ────────────────────────────────────────────────────

export const FEEDBACK_RECEIVED_KINDS = [
  "intro",
  "reminder",
  "reply",
  "closing",
  "handoff",
  "fallback",
  /** «Δεν μπορούμε να συνεχίσουμε κουβέντα έτσι, εγώ σταματάω 🍌» */
  "hostility_stop",
  "stop_ack",
  /** «δεν μπορούμε να ακούσουμε φωνητικά» — one per conversation, not per note. */
  "media_notice",
  "staff",
] as const;

export type FeedbackReceivedKind = (typeof FEEDBACK_RECEIVED_KINDS)[number];

export interface FeedbackReceivedMessage {
  /** Assert this. Application-owned copy may also be asserted by `text`. */
  readonly kind: FeedbackReceivedKind;
  readonly text: string;
}

export interface FeedbackTranscriptEntry {
  readonly who: "participant" | "bot" | "staff" | "system";
  readonly text: string;
  /** What the bot was saying. `null` for a participant turn. */
  readonly kind: FeedbackReceivedKind | null;
}

/**
 * Where the conversation ended up. The whole assertion vocabulary of the suite.
 *
 * Every field is something a human would look at in the admin or on their
 * phone: what was recorded, who it is about **by name**, what the participant
 * was actually sent, whether an operator was called, and whether the
 * participant's own words still exist. Nothing here is a mechanism, so §7 can
 * delete the goal ladder, the cursor and per-turn extraction without this file
 * changing.
 */
export interface FeedbackLoopOutcome {
  readonly lifecycle: "open" | "closed";
  readonly closedBecause:
    "completed" | "stopped" | "expired" | "cancelled" | null;
  readonly control: "bot" | "human";
  /** The participant's standing consent to be messaged again. */
  readonly optedIn: boolean;

  /** Recorded answers, by question and by the display name they are about. */
  readonly answers: readonly {
    readonly question: FeedbackAnswerQuestionKey;
    readonly about: string | null;
    readonly value: number | null;
  }[];
  /** Recorded notes, in the order they were written. */
  readonly notes: readonly {
    readonly type: FeedbackNoteType;
    readonly text: string;
    readonly about: string | null;
    readonly flagged: boolean;
  }[];

  readonly needsAttention: boolean;
  readonly flaggedMessages: readonly {
    readonly text: string;
    readonly categories: readonly PostEventFeedbackSafetyCategory[];
    readonly action: PostEventFeedbackRecommendedAction;
  }[];
  readonly alerts: readonly {
    readonly reason: string;
    readonly detail: readonly string[];
  }[];

  /** What the participant actually received, in order, read from the transport. */
  readonly received: readonly FeedbackReceivedMessage[];
  /** The same thing counted by kind. Every kind is present, so `{ closing: 0 }` asserts. */
  readonly receivedCount: Record<FeedbackReceivedKind, number>;
  /** The conversation as a human reads it, in order. */
  readonly transcript: readonly FeedbackTranscriptEntry[];

  /** Participant words the system still holds somewhere a human can read them. */
  readonly retainedParticipantText: readonly string[];
  /**
   * Participant words that arrived and are held nowhere, in full, any more.
   * `lostParticipantText: []` is how a scenario says "nothing this person said
   * was destroyed" without naming a store or a processing status.
   */
  readonly lostParticipantText: readonly string[];
}

type Expected<T> = T extends readonly (infer Element)[]
  ? readonly Expected<Element>[]
  : T extends Date
    ? T
    : T extends object
      ? { readonly [Key in keyof T]?: Expected<T[Key]> }
      : T;

export type ExpectedFeedbackOutcome = Expected<FeedbackLoopOutcome>;

interface FeedbackScenarioBase {
  /** The snake_case name from the scenario catalogue, e.g. `burst_typist`. */
  readonly id: string;
  /** The human sentence describing what should happen. */
  readonly title: string;
  readonly seed?: FeedbackSeedOptions;
  readonly script?: readonly ModelTurn[];
  /** One entry per model call, not per scenario step. */
  readonly attention?: readonly AttentionTurn[];
  /**
   * Narrow escape hatch for a scenario that deliberately fills the transcript
   * with many irrelevant turns. Normal rows must script every provider call so
   * an accidental extra paid call cannot hide behind an empty default result.
   */
  readonly allowUnscriptedExtractionCalls?: boolean;
  /**
   * Exact background failures intentionally caused by this scenario. Every
   * unlisted failure fails the row before outcome assertions run.
   */
  readonly expectedJobFailures?: readonly ExpectedJobFailure[];
  readonly steps: readonly FeedbackStep[];
  readonly expect: ExpectedFeedbackOutcome;
}

export interface ExpectedJobFailure {
  readonly job: FeedbackJobName;
  readonly kind: ModelFailure;
  readonly count: number;
}

export type FeedbackScenario =
  | (FeedbackScenarioBase & {
      readonly defect?: undefined;
      readonly knownCurrent?: never;
    })
  | (FeedbackScenarioBase & {
      /**
       * Diagnostic label for a known production defect. Clear this together
       * with `knownCurrent` when the desired outcome lands.
       */
      readonly defect: string;
      /**
       * The exact observable subset produced by the known defect today.
       * `expect` remains the desired product contract.
       */
      readonly knownCurrent: ExpectedFeedbackOutcome;
    });
