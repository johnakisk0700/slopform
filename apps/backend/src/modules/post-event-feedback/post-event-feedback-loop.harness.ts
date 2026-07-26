import { Logger } from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";
import { UnrecoverableError, type Job, type Queue } from "bullmq";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { AuditRepository } from "../../infrastructure/audit/audit.repository.js";
import type { Environment } from "../../infrastructure/config/environment.js";
import type { DatabaseService } from "../../infrastructure/database/database.service.js";
import type { FeedbackConversationRepository } from "../conversations/feedback-conversation.repository.js";
import {
  buildFeedbackConversationGoals,
  deriveFeedbackConversationId,
  type FeedbackConversationDocument,
  type FeedbackConversationGoal,
} from "../conversations/feedback-conversation.schemas.js";
import type { EventsRepository } from "../events/events.repository.js";
import type { EventsService } from "../events/events.service.js";
import type { ParticipantsRepository } from "../participants/participants.repository.js";
import type { FeedbackOperatorAlert } from "./feedback-operator-alert.js";
import { FeedbackOutboundTranscriptService } from "./feedback-outbound-transcript.service.js";
import type { FeedbackTransport } from "./feedback-transport.js";
import { MessageOutboxDeliveryService } from "./message-outbox-delivery.service.js";
import { MessageOutboxRelayService } from "./message-outbox-relay.service.js";
import type {
  PostEventFeedbackRecommendedAction,
  PostEventFeedbackSafetyCategory,
} from "./post-event-feedback-attention.js";
import { PostEventFeedbackExtractionFallback } from "./post-event-feedback-extraction-fallback.service.js";
import {
  FeedbackExtractionGenerationError,
  type FeedbackAttentionClassificationGenerationResult,
  type FeedbackExtractionGenerationResult,
  type PostEventFeedbackExtractionModel,
} from "./post-event-feedback-extraction.service.js";
import {
  FEEDBACK_EXTRACTION_MAX_SOURCE_MESSAGES,
  POST_EVENT_FEEDBACK_FALLBACK_ACK,
  POST_EVENT_FEEDBACK_HANDOFF_REPLY,
  feedbackExtractionProposalSchema,
  type FeedbackExtractionMessageView,
  type FeedbackExtractionProposal,
} from "./post-event-feedback-extraction.schemas.js";
import { PostEventFeedbackExtractor } from "./post-event-feedback-extractor.service.js";
import { PostEventFeedbackIngressService } from "./post-event-feedback-ingress.service.js";
import { PostEventFeedbackConversationService } from "./post-event-feedback-conversation.service.js";
import {
  FakeAudit,
  FakeDatabase,
  FakeEvents,
  FakeFeedbackConversations,
  FakeFeedbackRepository,
  FakeOperatorAlert,
  FakeParticipants,
  FEEDBACK_TEST_DEFAULT_JOB_ATTEMPTS,
  RecordingFeedbackTransport,
  type FakeOutboxRow,
} from "./post-event-feedback-doubles.harness.js";
import { PostEventFeedbackMaterializer } from "./post-event-feedback-materializer.service.js";
import { PostEventFeedbackMetrics } from "./post-event-feedback-metrics.service.js";
import type {
  FeedbackAnswerQuestionKey,
  FeedbackNoteType,
} from "@join-the-six/database";
import {
  POST_EVENT_FEEDBACK_QUESTION_SET_V1,
  createFeedbackIntroDedupeKey,
  renderPostEventFeedbackCopy,
} from "./post-event-feedback-question-set.js";
import { PostEventFeedbackProcessor } from "./post-event-feedback.processor.js";
import type { PostEventFeedbackRepository } from "./post-event-feedback.repository.js";
import { PostEventFeedbackSweepService } from "./post-event-feedback-sweep.service.js";
import {
  FEEDBACK_EXTRACT_QUIET_WINDOW_MS,
  FEEDBACK_JOB_NAMES,
  FEEDBACK_JOB_SCHEMA_VERSION,
  boundObservedMessageText,
  type FeedbackJobData,
  type FeedbackJobName,
} from "./post-event-feedback.schemas.js";
import { FEEDBACK_SWEEP_EVERY_MS } from "./feedback-sweep-scheduler.service.js";

/**
 * Fake-backed behavioural harness for the post-event feedback conversation
 * loop. This is deliberately not an E2E test: no real store, Redis worker or
 * provider participates.
 *
 * The whole loop runs for real — ingress, materializer, extractor, validation,
 * the deterministic fallback, the outbox relay, delivery, the sweeps and the
 * BullMQ processor with its retry classification. Only five things are faked,
 * and each is a genuine boundary: the two stores, the queue, the WhatsApp
 * transport and the model provider (`post-event-feedback-doubles.harness.ts`).
 *
 * ## What a scenario may say
 *
 * **Input** is only ever an external observation or action: a message arrived,
 * an outbound was observed on the shared session, time passed, staff acted, or
 * an upstream campaign/consent gate changed. Nothing reaches into an extractor
 * or mutates a conversation aggregate directly.
 *
 * **Assertions** are outcomes, never mechanism. `outcome()` is the entire
 * assertion vocabulary and it deliberately exposes no job id, no queue state,
 * no delay, no extraction cursor, no goal status, no rejection reason, no
 * ingress processing status and no UUID. Those are all scheduled for deletion
 * by §7 of the loop plan (extraction at rest); a suite that asserts them would
 * have to be rewritten alongside it, which is the opposite of what it is for.
 *
 * ## How to write an assertion that survives a refactor
 *
 * Dozens of scenarios share this harness. If every one pins a full picture, an
 * ordinary code change breaks forty tests and the team spends its life
 * repairing them. So:
 *
 * 1. **Always `toMatchObject`, never `toEqual`, and never a snapshot file.** A
 *    snapshot breaks on every unrelated field, which is exactly the failure
 *    mode this suite must not have.
 * 2. **Assert two to four facts — only what the scenario is about.** A STOP
 *    scenario says nothing about answers. A fragmentation scenario says nothing
 *    about lifecycle. Leaving a key out is not laziness, it is the design.
 * 3. **Never assert model-written text verbatim.** Reply wording comes from the
 *    model and will change. Assert the *kind* and the *count* of what the
 *    participant received (`received: [{ kind: "reply" }]`, or
 *    `receivedCount: { reply: 1 }`). Copy the application owns — the closing
 *    line, the handoff line, the STOP acknowledgement — may be asserted
 *    verbatim, because it is ours.
 * 4. **Transcript order is a first-class assertion.** An out-of-order webhook
 *    can invert what a split thought means, so `transcript` is an ordered list
 *    of `{ who, text, kind }` read the way a human reads the admin pane.
 *    Assert that sequence; never assert `seq`, timestamps or storage order.
 * 5. **Prefer counts and kinds over identities** wherever identity is not the
 *    point of the scenario.
 *
 * The trade is explicit: a looser individual test catches less on its own, and
 * the breadth of the suite is what does the catching instead. That is the
 * right balance here. Do not "improve" this suite by tightening it.
 *
 * ## The known-defect ledger
 *
 * Many scenarios describe behaviour the code gets wrong today. **Never write a
 * test that asserts current broken behaviour as the desired contract.** Keep
 * `expect` as the desired outcome and add `knownCurrent`. The runner requires
 * the observed outcome to match that exact diagnostic subset and requires it
 * not to match the desired outcome. A random worker crash therefore cannot
 * turn a known-defect row green, unlike bare `it.fails`.
 */

// ── Fixed identity ──────────────────────────────────────────────────────────
// Fixed rather than random so a failure is reproducible and a diff is readable.
// Scenarios never type any of these: names resolve to ids inside the harness.

const CAMPAIGN_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const EVENT_ID = "5c2f0b8e-9b1a-4a41-8f27-1a6f9b0c2d10";
const PERSON_IDS = [
  "9f3c1a52-6e2b-4b4a-9a17-2cb2a6d13a55",
  "1b0a2f1c-2d3e-4f50-8a91-0b2c3d4e5f60",
  "2c1b3a2d-3e4f-5061-9b02-1c3d4e5f6071",
  "3d2c4b3e-4f50-6172-8c13-2d4e5f607182",
  "4e3d5c4f-5061-7283-9d24-3e5f60718293",
  "5f4e6d50-6172-8394-8e35-4f60718293a4",
  "60517e61-7283-94a5-9f46-5071829304b5",
  "71628f72-8394-a5b6-8057-61829304b5c6",
] as const;

const FEEDBACK_LOOP_START = new Date("2026-07-25T20:00:00.000Z");
export const DEFAULT_RESPONDENT = "Μαρία";
const DEFAULT_PHONE = "+306900000001";
const DEFAULT_CANDIDATES = [
  "Νίκος",
  "Ελένη",
  "Κώστας Π.",
  "Κώστας Γ.",
] as const;

const RELAY_JOB_ID = "feedback-relay-outbox-v1";
const MAX_DRAIN_STEPS = 100_000;
const TEST_STAFF_ID = "staff-loop-harness";

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
export type Duration =
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

function parseDuration(duration: Duration): number {
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

/** One classification call's worth of signals. Empty means "nothing to flag". */
export type AttentionTurn = readonly ScriptedAttention[];

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
      readonly observedAt?: Duration;
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
      readonly observedAt?: Duration;
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
  | (FeedbackExternalAction & { readonly after?: Duration })
  /** Time passed. Delayed extraction runs and the sweeps fire inside it. */
  | { readonly kind: "wait"; readonly after: Duration }
  /**
   * Start advancing the worker clock, wait until the extraction provider call
   * is genuinely in flight, apply one external action, then release the call.
   * This is the race vocabulary; scenario code never reaches into the extractor.
   */
  | {
      readonly kind: "during_model";
      readonly after: Duration;
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

// ── The scripted model ──────────────────────────────────────────────────────

const SCRIPT_MODEL = "google/gemini-3.6-flash";
const SCRIPT_USAGE = { inputTokens: 800, outputTokens: 110, totalTokens: 910 };

export interface ScriptedModelPause {
  /** Resolves only after the provider boundary has been entered. */
  readonly started: Promise<void>;
  /** Let the provider call return to the extractor. Idempotent. */
  release(): void;
}

interface PendingModelPause {
  readonly phase: "extraction" | "attention";
  readonly started: Promise<void>;
  markStarted(): void;
  readonly released: Promise<void>;
  release(): void;
}

/**
 * The model boundary, driven by a scenario's script.
 *
 * `propose` receives rendered Greek prose and must answer with transcript
 * message **ids** the scenario cannot know in advance, so the job driver tells
 * this class which conversation the run is about and citations are resolved
 * here against the live transcript. Every proposal is parsed by the real
 * proposal schema before it is returned, exactly as the production boundary
 * does, so a scripted turn cannot smuggle in a shape the provider could not
 * have produced.
 */
export class ScriptedExtractionModel {
  private turns: readonly ModelTurn[] = [];
  private attentionTurns: readonly AttentionTurn[] = [];
  private turnIndex = 0;
  private attentionIndex = 0;
  private failuresTaken = 0;
  private runConversationId: string | undefined;
  private readonly attemptedTurnIndexes = new Set<number>();
  private readonly emittedFailures: ModelFailure[] = [];
  private pendingPause: PendingModelPause | undefined;
  private allowUnscriptedExtractionCalls = false;

  constructor(
    private readonly conversations: FakeFeedbackConversations,
    private readonly idByName: ReadonlyMap<string, string>,
  ) {}

  script(
    turns: readonly ModelTurn[],
    allowUnscriptedExtractionCalls = false,
  ): void {
    this.turns = [...turns];
    this.turnIndex = 0;
    this.failuresTaken = 0;
    this.attemptedTurnIndexes.clear();
    this.emittedFailures.splice(0);
    this.allowUnscriptedExtractionCalls = allowUnscriptedExtractionCalls;
  }

  scriptAttention(turns: readonly AttentionTurn[]): void {
    this.attentionTurns = [...turns];
    this.attentionIndex = 0;
  }

  /** Called by the job driver immediately before an extraction job is dispatched. */
  beginRun(conversationId: string): void {
    this.runConversationId = conversationId;
  }

  /**
   * Pause exactly the next provider call at the requested phase. The extractor
   * has already snapshotted its context when `started` resolves.
   */
  pauseNext(
    phase: "extraction" | "attention" = "extraction",
  ): ScriptedModelPause {
    if (this.pendingPause) {
      throw new Error("A scripted model pause is already waiting");
    }
    let markStarted!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.pendingPause = {
      phase,
      started,
      markStarted,
      released,
      release,
    };
    return { started, release };
  }

  /** The 1-based scripted call positions that no provider call reached. */
  get unconsumedExtractionCalls(): readonly number[] {
    return this.turns.flatMap((_turn, index) =>
      this.attemptedTurnIndexes.has(index) ? [] : [index + 1],
    );
  }

  /** The 1-based attention call positions that no classifier call reached. */
  get unconsumedAttentionCalls(): readonly number[] {
    return this.attentionTurns.flatMap((_turn, index) =>
      index < this.attentionIndex ? [] : [index + 1],
    );
  }

  /** Debugging aid retained for direct harness callers. */
  get unusedTurns(): number {
    return this.unconsumedExtractionCalls.length;
  }

  takeEmittedFailure(): ModelFailure | undefined {
    return this.emittedFailures.shift();
  }

  async propose(): Promise<FeedbackExtractionGenerationResult> {
    const conversation = this.requireRunConversation();
    await this.waitAtPause("extraction");
    const turn = this.turns[this.turnIndex];
    if (!turn) {
      if (this.allowUnscriptedExtractionCalls) {
        return this.emit(buildProposal({}, conversation, this.idByName));
      }
      throw new Error(
        `Unexpected extraction provider call ${this.turnIndex + 1}: the scenario script is exhausted`,
      );
    }

    this.attemptedTurnIndexes.add(this.turnIndex);
    const failure = this.takeScriptedFailure(turn);
    if (failure) {
      throw failure;
    }
    this.turnIndex += 1;
    this.failuresTaken = 0;
    return this.emit(buildProposal(turn, conversation, this.idByName));
  }

  async classifyAttention(
    messages: readonly FeedbackExtractionMessageView[],
    targetMessageIds: readonly string[],
  ): Promise<FeedbackAttentionClassificationGenerationResult> {
    await this.waitAtPause("attention");
    const turn = this.attentionTurns[this.attentionIndex] ?? [];
    this.attentionIndex += 1;
    return {
      model: SCRIPT_MODEL,
      usage: { inputTokens: 180, outputTokens: 40, totalTokens: 220 },
      estimatedPromptTokens: 200,
      signals: turn.map((signal) => ({
        category: signal.category,
        recommendedAction: signal.action,
        sourceMessageIds: resolveAttentionCite(
          signal.on ?? "all-new",
          messages,
          targetMessageIds,
        ),
        confidence: signal.confidence ?? 0.9,
      })),
    };
  }

  private emit(
    proposal: Record<string, unknown>,
  ): FeedbackExtractionGenerationResult {
    let parsed: FeedbackExtractionProposal;
    try {
      parsed = feedbackExtractionProposalSchema.parse(proposal);
    } catch {
      // The production boundary reports a response that never satisfied the
      // agreed schema exactly this way.
      throw new FeedbackExtractionGenerationError(
        "extraction_failed",
        true,
        "validation_failed",
      );
    }
    return { model: SCRIPT_MODEL, proposal: parsed, usage: SCRIPT_USAGE };
  }

  private takeScriptedFailure(turn: ModelTurn): Error | undefined {
    if (!turn.fails) {
      return undefined;
    }
    this.failuresTaken += 1;
    this.emittedFailures.push(turn.fails);
    return modelFailure(turn.fails);
  }

  private async waitAtPause(phase: PendingModelPause["phase"]): Promise<void> {
    const pause = this.pendingPause;
    if (!pause || pause.phase !== phase) {
      return;
    }
    this.pendingPause = undefined;
    pause.markStarted();
    await pause.released;
  }

  private requireRunConversation(): FeedbackConversationDocument {
    if (!this.runConversationId) {
      throw new Error(
        "The scripted model was called outside an extraction run",
      );
    }
    return this.conversations.get(this.runConversationId);
  }
}

function modelFailure(
  failure: ModelFailure,
): FeedbackExtractionGenerationError {
  switch (failure) {
    case "unavailable":
      return new FeedbackExtractionGenerationError(
        "provider_unavailable",
        false,
        "provider_error",
      );
    case "refuses":
      return new FeedbackExtractionGenerationError(
        "extraction_failed",
        true,
        "provider_refusal",
      );
    case "malformed":
      return new FeedbackExtractionGenerationError(
        "extraction_failed",
        true,
        "validation_failed",
      );
    default:
      return new FeedbackExtractionGenerationError(
        "extraction_failed",
        true,
        "provider_error",
      );
  }
}

function buildProposal(
  turn: ModelTurn,
  conversation: FeedbackConversationDocument,
  idByName: ReadonlyMap<string, string>,
): Record<string, unknown> {
  const subject = (
    about: string | undefined,
  ): { id: string | null; mentioned: string | null } => {
    if (!about) {
      return { id: null, mentioned: null };
    }
    return { id: idByName.get(about) ?? null, mentioned: about };
  };

  return {
    answers: (turn.answers ?? []).map((answer) => {
      const resolved = subject(answer.about);
      return {
        questionKey: answer.question,
        valueInt: answer.value ?? null,
        subjectParticipantId: resolved.id,
        subjectMentionedName: resolved.mentioned,
        sourceMessageIds: resolveCite(answer.cite ?? "all-new", conversation),
        confidence: answer.confidence ?? 0.9,
      };
    }),
    notes: (turn.notes ?? []).map((note) => {
      const resolved = subject(note.about);
      return {
        noteType: note.type ?? "general",
        text: note.text,
        subjectParticipantId: resolved.id,
        subjectMentionedName: resolved.mentioned,
        sourceMessageIds: resolveCite(note.cite ?? "all-new", conversation),
        confidence: note.confidence ?? 0.7,
      };
    }),
    skippedGoals: [...(turn.skip ?? [])],
    nextGoal: turn.next ?? null,
    reply: turn.reply ?? null,
    handoff: turn.handoff ?? false,
    confidence: turn.confidence ?? 0.9,
  };
}

function resolveCite(
  cite: Cite,
  conversation: FeedbackConversationDocument,
): string[] {
  const participant = conversation.messages.filter(
    (message) => message.actor === "participant",
  );
  const unread = participant.filter(
    (message) => message.seq > conversation.extraction.cursorSeq,
  );
  const pick = (reference: string | number): string[] => {
    if (typeof reference === "number") {
      const message = participant[reference - 1];
      if (!message) {
        throw new Error(
          `The scenario cited participant message #${reference}, which does not exist`,
        );
      }
      return [message.id];
    }
    switch (reference) {
      case "all-new":
        return (unread.length > 0 ? unread : participant.slice(-1)).map(
          (message) => message.id,
        );
      case "last":
        return participant.at(-1) ? [participant.at(-1)!.id] : [];
      case "bot": {
        const bot = conversation.messages.filter(
          (message) => message.actor === "bot",
        );
        return bot.at(-1) ? [bot.at(-1)!.id] : [];
      }
      default: {
        const match = participant.find(
          (message) => message.text === reference.trim(),
        );
        if (!match) {
          throw new Error(
            `The scenario cited a participant message reading "${reference}", which was never sent`,
          );
        }
        return [match.id];
      }
    }
  };

  const references = Array.isArray(cite)
    ? (cite as readonly (string | number)[])
    : [cite as string | number];
  const ids = [...new Set(references.flatMap((reference) => pick(reference)))];
  if (ids.length === 0) {
    throw new Error(
      "The scenario scripted an extraction before the participant said anything",
    );
  }
  // Do not trim to the production bound here. The real proposal schema must
  // accept or reject exactly what the scenario scripted; slicing with the same
  // constant would let a bound regression silently rewrite the test input.
  return ids;
}

function resolveAttentionCite(
  cite: Cite,
  messages: readonly FeedbackExtractionMessageView[],
  targetMessageIds: readonly string[],
): string[] {
  if (cite === "all-new") {
    return [...targetMessageIds].slice(
      0,
      FEEDBACK_EXTRACTION_MAX_SOURCE_MESSAGES,
    );
  }
  if (cite === "last") {
    const last = targetMessageIds.at(-1);
    return last ? [last] : [];
  }
  const references = Array.isArray(cite)
    ? (cite as readonly (string | number)[])
    : [cite as string | number];
  const participant = messages.filter(
    (message) => message.actor === "participant",
  );
  return references.flatMap((reference) => {
    if (typeof reference === "number") {
      const message = participant[reference - 1];
      return message ? [message.id] : [];
    }
    const match = participant.find(
      (message) => message.text === reference.trim(),
    );
    return match ? [match.id] : [];
  });
}

// ── The queue ───────────────────────────────────────────────────────────────

interface QueuedJob {
  readonly id: string;
  readonly name: FeedbackJobName;
  readonly data: FeedbackJobData;
  readonly runAt: number;
  readonly attempts: number;
  readonly enqueueSeq: number;
  attemptsMade: number;
}

/**
 * BullMQ's semantics, as far as they are observable from a scenario: an `add`
 * for a job id that is still waiting is a no-op, a completed job releases its
 * id, `delay` is honoured against the test clock, and jobs drain in `runAt`
 * order at concurrency one.
 */
class FakeFeedbackQueue {
  private readonly waiting = new Map<string, QueuedJob>();
  private sequence = 0;

  constructor(private readonly nowMs: () => number) {}

  async add(
    name: FeedbackJobName,
    data: FeedbackJobData,
    options?: { jobId?: string; delay?: number; attempts?: number },
  ): Promise<{ id: string }> {
    this.sequence += 1;
    const id = options?.jobId ?? `${name}-${this.sequence}`;
    if (!this.waiting.has(id)) {
      this.waiting.set(id, {
        id,
        name,
        data,
        runAt: this.nowMs() + (options?.delay ?? 0),
        attempts: options?.attempts ?? FEEDBACK_TEST_DEFAULT_JOB_ATTEMPTS,
        enqueueSeq: this.sequence,
        attemptsMade: 0,
      });
    }
    return { id };
  }

  /** The schedulers run at bootstrap; the harness owns repeat cadence instead. */
  async upsertJobScheduler(): Promise<void> {}

  earliestDue(target: number): QueuedJob | undefined {
    let best: QueuedJob | undefined;
    for (const job of this.waiting.values()) {
      if (job.runAt > target) {
        continue;
      }
      if (
        !best ||
        job.runAt < best.runAt ||
        (job.runAt === best.runAt && job.enqueueSeq < best.enqueueSeq)
      ) {
        best = job;
      }
    }
    return best;
  }

  take(id: string): void {
    this.waiting.delete(id);
  }
}

interface Repeatable {
  readonly id: string;
  readonly name: FeedbackJobName;
  readonly data: FeedbackJobData;
  readonly everyMs: number;
  nextAt: number;
}

// ── The harness ─────────────────────────────────────────────────────────────

export interface FeedbackLoopHarness {
  readonly conversationId: string;
  readonly model: ScriptedExtractionModel;
  readonly transport: RecordingFeedbackTransport;
  readonly conversations: FakeFeedbackConversations;
  readonly repository: FakeFeedbackRepository;
  readonly participants: FakeParticipants;
  readonly events: FakeEvents;
  readonly alerts: FakeOperatorAlert;
  readonly audit: FakeAudit;
  /** Job failures, for debugging a surprising outcome. Not an assertion surface. */
  readonly failures: readonly {
    readonly job: string;
    readonly kind?: ModelFailure;
    readonly error: unknown;
  }[];
  now(): Date;
  advance(after: Duration): Promise<void>;
  apply(step: FeedbackStep): Promise<void>;
  run(steps: readonly FeedbackStep[]): Promise<void>;
  outcome(): FeedbackLoopOutcome;
}

/**
 * Builds one campaign, one respondent, one conversation and the whole loop
 * around them, with the clock at {@link FEEDBACK_LOOP_START}.
 *
 * Only `Date` is faked. Promises and the microtask queue stay real — the
 * services are `async` throughout, so faking timers wholesale deadlocks the
 * drain loop. Callers outside {@link runFeedbackScenarios} must restore the
 * clock themselves with `afterEach(() => { vi.useRealTimers(); })`.
 */
export async function createFeedbackLoopHarness(
  seed: FeedbackSeedOptions = {},
): Promise<FeedbackLoopHarness> {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(FEEDBACK_LOOP_START);

  let nowMs = FEEDBACK_LOOP_START.getTime();
  const now = (): Date => new Date(nowMs);
  const setNow = (value: number): void => {
    nowMs = value;
    vi.setSystemTime(new Date(value));
  };

  const respondentName = seed.respondent ?? DEFAULT_RESPONDENT;
  const candidateNames = seed.candidates ?? [...DEFAULT_CANDIDATES];
  const phone = seed.phone ?? DEFAULT_PHONE;
  const idByName = new Map<string, string>();
  const nameById = new Map<string, string>();
  for (const [index, name] of [respondentName, ...candidateNames].entries()) {
    const id = PERSON_IDS[index];
    if (!id) {
      throw new Error("The harness seeds at most eight people");
    }
    idByName.set(name, id);
    nameById.set(id, name);
  }
  const respondentId = idByName.get(respondentName)!;

  const database = new FakeDatabase();
  const repository = new FakeFeedbackRepository(now);
  const conversations = new FakeFeedbackConversations();
  const participants = new FakeParticipants();
  const events = new FakeEvents();
  const audit = new FakeAudit();
  const alerts = new FakeOperatorAlert();
  const metrics = new PostEventFeedbackMetrics();
  const transport = new RecordingFeedbackTransport(now);
  const model = new ScriptedExtractionModel(conversations, idByName);
  const queue = new FakeFeedbackQueue(() => nowMs);
  const config = {
    get: (key: string) =>
      ({
        FEEDBACK_REMINDER_AFTER_HOURS: 24,
        FEEDBACK_EXPIRE_AFTER_HOURS: 72,
        FEEDBACK_MAX_REMINDERS: 2,
        FEEDBACK_INGRESS_PENDING_RECOVERY_MINUTES: 5,
      })[key],
  } as unknown as ConfigService<Environment, true>;

  const copy = { ...POST_EVENT_FEEDBACK_QUESTION_SET_V1.copy };
  repository.campaigns.set(CAMPAIGN_ID, {
    id: CAMPAIGN_ID,
    eventId: EVENT_ID,
    status: seed.campaign ?? "launched",
    questions: { questionSetVersion: 1, copy },
  });
  participants.rows.set(respondentId, {
    id: respondentId,
    preferredName: respondentName,
    emailNormalized: `${respondentId}@example.test`,
    phoneE164: phone,
    postEventFeedbackWhatsappOptIn: seed.optedIn ?? true,
  });
  for (const name of candidateNames) {
    const id = idByName.get(name)!;
    participants.rows.set(id, {
      id,
      preferredName: name,
      emailNormalized: `${id}@example.test`,
      phoneE164: null,
      postEventFeedbackWhatsappOptIn: true,
    });
  }
  events.candidates = candidateNames.map((name) => ({
    participantId: idByName.get(name)!,
    displayName: name,
  }));

  const conversationId = deriveFeedbackConversationId(
    CAMPAIGN_ID,
    respondentId,
  );
  const wantsIntro = true;
  const goalStatuses: Partial<
    Record<FeedbackAnswerQuestionKey, FeedbackConversationGoal["status"]>
  > = {
    // The catalogue's scenario zero: the intro asked the first question.
    ...(wantsIntro ? { event_score: "asked" as const } : {}),
    ...seed.goals,
  };
  conversations.seed({
    _id: conversationId,
    schemaVersion: 2,
    purpose: "post_event_feedback",
    channel: "whatsapp",
    campaignId: CAMPAIGN_ID,
    respondentParticipantId: respondentId,
    phoneAtLaunch: phone,
    lifecycle: { state: "open", reason: null, closedAt: null },
    control: { mode: "bot", source: "launch", changedAt: FEEDBACK_LOOP_START },
    goals: buildFeedbackConversationGoals(copy).map((goal) => ({
      ...goal,
      status: goalStatuses[goal.key] ?? goal.status,
    })),
    messages: [],
    extraction: { cursorSeq: 0, lastRunAt: null, model: null },
    needsAttention: false,
    remindedAt: null,
    reminderCount: 0,
    awaitingHuman: false,
    createdAt: FEEDBACK_LOOP_START,
    updatedAt: FEEDBACK_LOOP_START,
  });

  // Seeding happens before the tape starts rolling: the intro is an already
  // delivered bot turn, so `received` only ever holds what the scenario caused.
  if (wantsIntro) {
    const intro = repository.seedOutbox({
      conversationId,
      campaignId: CAMPAIGN_ID,
      kind: "intro",
      body: renderPostEventFeedbackCopy(copy.intro, respondentName),
      dedupeKey: createFeedbackIntroDedupeKey(conversationId),
      status: "sent",
      providerLogId: "log-seed-intro",
      providerMessageId: "wa-seed-intro",
      deliveryStatus: "sent",
      sentAt: FEEDBACK_LOOP_START,
    });
    await conversations.appendMessage({
      conversationId,
      actor: "bot",
      text: intro.body,
      at: FEEDBACK_LOOP_START,
      outboxId: intro.id,
    });
  }
  for (const answer of seed.answers ?? []) {
    await repository.insertAnswerIfAbsent({} as never, {
      campaignId: CAMPAIGN_ID,
      conversationId,
      respondentParticipantId: respondentId,
      subjectParticipantId: answer.about
        ? (idByName.get(answer.about) ?? null)
        : null,
      questionKey: answer.question,
      valueInt: answer.value ?? null,
      sourceMessageIds: ["seeded"],
      extractionMeta: { model: SCRIPT_MODEL, confidence: 1, candidateIds: [] },
    });
  }
  if (seed.control === "human") {
    await conversations.takeOver({
      conversationId,
      source: "staff_action",
      at: FEEDBACK_LOOP_START,
    });
  }
  if (seed.closed) {
    await conversations.close({
      conversationId,
      reason: seed.closed,
      at: FEEDBACK_LOOP_START,
    });
  }

  const queuePort = queue as unknown as Queue<
    FeedbackJobData,
    void,
    FeedbackJobName
  >;
  const outboundTranscript = new FeedbackOutboundTranscriptService(
    database as unknown as DatabaseService,
    repository as unknown as PostEventFeedbackRepository,
    conversations as unknown as FeedbackConversationRepository,
  );
  const staffConversations = new PostEventFeedbackConversationService(
    queuePort,
    database as unknown as DatabaseService,
    repository as unknown as PostEventFeedbackRepository,
    conversations as unknown as FeedbackConversationRepository,
    events as unknown as EventsRepository,
    events as unknown as EventsService,
    participants as unknown as ParticipantsRepository,
    audit as unknown as AuditRepository,
    outboundTranscript,
  );
  const ingress = new PostEventFeedbackIngressService(
    queuePort,
    database as unknown as DatabaseService,
    repository as unknown as PostEventFeedbackRepository,
  );
  const processor = new PostEventFeedbackProcessor(
    new PostEventFeedbackMaterializer(
      queuePort,
      database as unknown as DatabaseService,
      repository as unknown as PostEventFeedbackRepository,
      conversations as unknown as FeedbackConversationRepository,
      participants as unknown as ParticipantsRepository,
      audit as unknown as AuditRepository,
      metrics,
      outboundTranscript,
    ),
    new MessageOutboxRelayService(
      queuePort,
      repository as unknown as PostEventFeedbackRepository,
    ),
    new MessageOutboxDeliveryService(
      database as unknown as DatabaseService,
      repository as unknown as PostEventFeedbackRepository,
      conversations as unknown as FeedbackConversationRepository,
      outboundTranscript,
      transport as FeedbackTransport,
    ),
    new PostEventFeedbackExtractor(
      database as unknown as DatabaseService,
      repository as unknown as PostEventFeedbackRepository,
      conversations as unknown as FeedbackConversationRepository,
      events as unknown as EventsService,
      participants as unknown as ParticipantsRepository,
      model as unknown as PostEventFeedbackExtractionModel,
      audit as unknown as AuditRepository,
      metrics,
      outboundTranscript,
      alerts as FeedbackOperatorAlert,
    ),
    new PostEventFeedbackSweepService(
      queuePort,
      config,
      database as unknown as DatabaseService,
      repository as unknown as PostEventFeedbackRepository,
      conversations as unknown as FeedbackConversationRepository,
      participants as unknown as ParticipantsRepository,
      audit as unknown as AuditRepository,
      outboundTranscript,
    ),
    new PostEventFeedbackExtractionFallback(
      database as unknown as DatabaseService,
      repository as unknown as PostEventFeedbackRepository,
      conversations as unknown as FeedbackConversationRepository,
      events as unknown as EventsService,
      audit as unknown as AuditRepository,
      outboundTranscript,
      alerts as FeedbackOperatorAlert,
    ),
  );

  const sweepData = {
    schemaVersion: FEEDBACK_JOB_SCHEMA_VERSION,
    correlationId: "sweep",
  } as const;
  const repeatables: Repeatable[] = [
    FEEDBACK_JOB_NAMES.sweepRemindersV1,
    FEEDBACK_JOB_NAMES.sweepExpiryV1,
    FEEDBACK_JOB_NAMES.sweepIngressV1,
  ].map((name) => ({
    id: name,
    name,
    data: sweepData,
    everyMs: FEEDBACK_SWEEP_EVERY_MS,
    nextAt: FEEDBACK_LOOP_START.getTime() + FEEDBACK_SWEEP_EVERY_MS,
  }));

  const failures: {
    job: string;
    kind?: ModelFailure;
    error: unknown;
  }[] = [];
  const inboundTexts: string[] = [];
  let observedCounter = 0;

  const runJob = async (job: QueuedJob): Promise<void> => {
    for (;;) {
      try {
        if (job.name === FEEDBACK_JOB_NAMES.extractV1) {
          model.beginRun(
            (job.data as { conversationId: string }).conversationId,
          );
        }
        await processor.process({
          id: job.id,
          name: job.name,
          data: job.data,
          attemptsMade: job.attemptsMade,
          opts: { attempts: job.attempts },
        } as unknown as Job<FeedbackJobData, void, FeedbackJobName>);
        return;
      } catch (error) {
        job.attemptsMade += 1;
        const kind =
          job.name === FEEDBACK_JOB_NAMES.extractV1
            ? model.takeEmittedFailure()
            : undefined;
        failures.push({
          job: job.name,
          ...(kind ? { kind } : {}),
          error,
        });
        if (
          error instanceof UnrecoverableError ||
          job.attemptsMade >= job.attempts
        ) {
          return;
        }
      }
    }
  };

  const drainTo = async (target: number): Promise<void> => {
    let relayOffered = false;
    const offerRelay = async (): Promise<void> => {
      relayOffered = true;
      await queue.add(
        FEEDBACK_JOB_NAMES.relayOutboxV1,
        {
          schemaVersion: FEEDBACK_JOB_SCHEMA_VERSION,
          correlationId: RELAY_JOB_ID,
        },
        { jobId: RELAY_JOB_ID, attempts: 1 },
      );
    };

    for (let guard = 0; guard < MAX_DRAIN_STEPS; guard += 1) {
      const job = queue.earliestDue(target);
      const repeat = repeatables
        .filter((candidate) => candidate.nextAt <= target)
        .sort((left, right) => left.nextAt - right.nextAt)[0];
      const nextAt = Math.min(
        job?.runAt ?? Number.POSITIVE_INFINITY,
        repeat?.nextAt ?? Number.POSITIVE_INFINITY,
      );

      if (nextAt === Number.POSITIVE_INFINITY) {
        if (relayOffered) {
          break;
        }
        await offerRelay();
        continue;
      }
      // The relay is not scheduled by anything a scenario controls, so it gets
      // its chance whenever the clock is about to move: an outbox row written
      // at 24h is delivered at 24h, not whenever the next job happens to land.
      if (nextAt > nowMs && !relayOffered) {
        await offerRelay();
        continue;
      }

      setNow(Math.max(nowMs, nextAt));
      if (job && job.runAt <= nextAt) {
        queue.take(job.id);
        await runJob(job);
        if (job.name !== FEEDBACK_JOB_NAMES.relayOutboxV1) {
          relayOffered = false;
        }
        continue;
      }
      if (repeat) {
        const fired: QueuedJob = {
          id: `${repeat.id}:${repeat.nextAt}`,
          name: repeat.name,
          data: repeat.data,
          runAt: repeat.nextAt,
          attempts: 1,
          enqueueSeq: 0,
          attemptsMade: 0,
        };
        repeat.nextAt += repeat.everyMs;
        await runJob(fired);
        relayOffered = false;
      }
    }
    setNow(target);
  };

  const advance = async (after: Duration): Promise<void> => {
    await drainTo(nowMs + parseDuration(after));
  };

  const applyExternalAction = async (
    action: FeedbackExternalAction,
  ): Promise<void> => {
    observedCounter += 1;
    if (action.kind === "inbound") {
      const bounded = boundObservedMessageText(action.text);
      if (action.text !== null) {
        inboundTexts.push(action.text.trim());
      }
      const from = action.from ?? phone;
      await ingress.recordObservedMessage(
        {
          providerMessageId:
            action.providerMessageId ?? `wa-in-${observedCounter}`,
          chatJid: toChatJid(from),
          direction: "inbound",
          phoneE164: from,
          text: bounded,
          observedAt:
            action.observedAt !== undefined
              ? new Date(
                  FEEDBACK_LOOP_START.getTime() +
                    parseDuration(action.observedAt),
                )
              : now(),
        },
        `corr-${observedCounter}`,
      );
    } else if (action.kind === "observed_outbound") {
      await ingress.recordObservedMessage(
        {
          providerMessageId:
            action.providerMessageId ?? `wa-obs-${observedCounter}`,
          chatJid: toChatJid(phone),
          direction: "outbound",
          phoneE164: phone,
          text: boundObservedMessageText(action.text),
          observedAt:
            action.observedAt !== undefined
              ? new Date(
                  FEEDBACK_LOOP_START.getTime() +
                    parseDuration(action.observedAt),
                )
              : now(),
        },
        `corr-${observedCounter}`,
      );
    } else if (action.kind === "staff") {
      const requestId = `staff-action-${observedCounter}`;
      if (action.action === "send") {
        await staffConversations.sendStaffMessage(
          CAMPAIGN_ID,
          conversationId,
          action.text,
          TEST_STAFF_ID,
          requestId,
        );
      } else if (action.action === "take_over") {
        await staffConversations.takeOver(
          CAMPAIGN_ID,
          conversationId,
          TEST_STAFF_ID,
          requestId,
        );
      } else if (action.action === "resume") {
        await staffConversations.resumeBot(
          CAMPAIGN_ID,
          conversationId,
          TEST_STAFF_ID,
          requestId,
        );
      } else if (action.action === "close") {
        await staffConversations.close(
          CAMPAIGN_ID,
          conversationId,
          TEST_STAFF_ID,
          requestId,
        );
      }
    } else if (action.kind === "campaign") {
      const campaign = repository.campaigns.get(CAMPAIGN_ID);
      if (!campaign) {
        throw new Error("The harness campaign disappeared");
      }
      campaign.status = action.status;
    } else if (action.kind === "consent") {
      await database.transaction(async (transaction) => {
        await participants.updateFeedbackOptIn(
          transaction,
          respondentId,
          action.optedIn,
        );
      });
    } else {
      transport.outcome = action.outcome;
    }
  };

  const apply = async (step: FeedbackStep): Promise<void> => {
    if (step.kind === "during_model") {
      const pause = model.pauseNext("extraction");
      const running = advance(step.after);
      try {
        await Promise.race([
          pause.started,
          running.then(() => {
            throw new Error(
              "during_model expected an extraction provider call, but the worker settled without one",
            );
          }),
        ]);
      } catch (error) {
        pause.release();
        throw error;
      }

      let actionError: unknown;
      try {
        await applyExternalAction(step.action);
      } catch (error) {
        actionError = error;
      }
      pause.release();
      await running;
      if (actionError) {
        throw actionError;
      }
      return;
    }

    await advance(step.after ?? 0);
    if (step.kind !== "wait") {
      await applyExternalAction(step);
    }
    await drainTo(nowMs);
  };

  const outcome = (): FeedbackLoopOutcome => {
    const conversation = conversations.get(conversationId);
    const outboxById = new Map(
      repository.outbox.map((row) => [row.id, row] as const),
    );
    const kindOf = (row: FakeOutboxRow | undefined): FeedbackReceivedKind =>
      row ? classifyOutbound(row, copy.closing) : "reply";

    const received = transport.sent.map((sent) => ({
      kind: kindOf(outboxById.get(sent.outboxId)),
      text: sent.text,
    }));
    const receivedCount = Object.fromEntries(
      FEEDBACK_RECEIVED_KINDS.map((kind) => [
        kind,
        received.filter((message) => message.kind === kind).length,
      ]),
    ) as Record<FeedbackReceivedKind, number>;

    // Raw ingress is an audit/recovery boundary, not a human-facing inbox.
    // Words count as retained only when the conversation transcript exposes
    // them to an operator.
    const humanVisibleParticipantText = new Set(
      conversation.messages
        .filter((message) => message.actor === "participant")
        .map((message) => message.text),
    );

    return {
      lifecycle: conversation.lifecycle.state,
      closedBecause: conversation.lifecycle.reason,
      control: conversation.control.mode,
      optedIn:
        participants.rows.get(respondentId)?.postEventFeedbackWhatsappOptIn ??
        false,
      answers: repository.answers
        .filter((row) => row.conversationId === conversationId)
        .map((row) => ({
          question: row.questionKey as FeedbackAnswerQuestionKey,
          about: row.subjectParticipantId
            ? (nameById.get(row.subjectParticipantId) ?? "unknown person")
            : null,
          value: row.valueInt,
        }))
        .sort(
          (left, right) =>
            questionOrdinal(left.question) - questionOrdinal(right.question) ||
            (left.about ?? "").localeCompare(right.about ?? ""),
        ),
      notes: repository.notes
        .filter((row) => row.conversationId === conversationId)
        .map((row) => ({
          type: row.noteType as FeedbackNoteType,
          text: row.text,
          about: row.subjectParticipantId
            ? (nameById.get(row.subjectParticipantId) ?? "unknown person")
            : null,
          flagged: row.extractionMeta["flaggedForReview"] === true,
        })),
      needsAttention: conversation.needsAttention,
      flaggedMessages: conversation.messages.flatMap((message) =>
        message.attention
          ? [
              {
                text: message.text,
                categories: message.attention.categories,
                action: message.attention.recommendedAction,
              },
            ]
          : [],
      ),
      alerts: alerts.raised.map((alert) => ({
        reason: alert.reason,
        detail: [...(alert.detail ?? [])],
      })),
      received,
      receivedCount,
      transcript: conversation.messages.map((message) => ({
        who: message.actor,
        text: message.text,
        kind:
          message.actor === "participant"
            ? null
            : kindOf(
                message.outboxId ? outboxById.get(message.outboxId) : undefined,
              ),
      })),
      retainedParticipantText: inboundTexts.filter((text) =>
        humanVisibleParticipantText.has(text),
      ),
      lostParticipantText: inboundTexts.filter(
        (text) => !humanVisibleParticipantText.has(text),
      ),
    };
  };

  return {
    conversationId,
    model,
    transport,
    conversations,
    repository,
    participants,
    events,
    alerts,
    audit,
    failures,
    now,
    advance,
    apply,
    async run(steps) {
      for (const step of steps) {
        await apply(step);
      }
    },
    outcome,
  };
}

function toChatJid(phoneE164: string): string {
  return `${phoneE164.replace("+", "")}@s.whatsapp.net`;
}

function questionOrdinal(key: FeedbackAnswerQuestionKey): number {
  return POST_EVENT_FEEDBACK_QUESTION_SET_V1.answerQuestions.findIndex(
    (question) => question.key === key,
  );
}

/**
 * What the participant experienced receiving, derived from the copy the
 * application owns rather than from a dedupe key, so the classification
 * survives a change of keying scheme.
 */
function classifyOutbound(
  row: FakeOutboxRow,
  closing: string,
): FeedbackReceivedKind {
  if (row.kind === "intro") {
    return "intro";
  }
  if (row.kind === "reminder") {
    return "reminder";
  }
  if (row.kind === "staff") {
    return "staff";
  }
  if (row.kind === "system") {
    // Both are application-owned `system` copy; the dedupe key is what says
    // which, and it is stable in a way the wording is not.
    return row.dedupeKey.startsWith("feedback-media-notice-")
      ? "media_notice"
      : "stop_ack";
  }
  const body = row.body.trim();
  if (body === closing.trim()) {
    return "closing";
  }
  if (body === POST_EVENT_FEEDBACK_HANDOFF_REPLY) {
    return "handoff";
  }
  if (body.startsWith(POST_EVENT_FEEDBACK_FALLBACK_ACK)) {
    return "fallback";
  }
  return "reply";
}

// ── The runner ──────────────────────────────────────────────────────────────

/**
 * Scenarios are data rows and one runner, not dozens of hand-written functions.
 * Known defects carry two explicit oracles: today's exact observable subset and
 * the desired product subset. Arbitrary exceptions never count as a reproduced
 * defect.
 */
export function runFeedbackScenarios(
  suite: string,
  scenarios: readonly FeedbackScenario[],
): void {
  describe(suite, () => {
    beforeAll(() => {
      Logger.overrideLogger(false);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    for (const scenario of scenarios) {
      const title = scenario.defect
        ? `${scenario.id} — ${scenario.title} [known defect: ${scenario.defect}]`
        : `${scenario.id} — ${scenario.title}`;

      it(title, async () => {
        const harness = await createFeedbackLoopHarness(scenario.seed);
        harness.model.script(
          scenario.script ?? [],
          scenario.allowUnscriptedExtractionCalls ?? false,
        );
        harness.model.scriptAttention(scenario.attention ?? []);
        await harness.run(scenario.steps);

        expect(
          summarizeJobFailures(harness.failures),
          "Background job failures differed from the scenario's explicit provider-failure contract",
        ).toEqual(summarizeExpectedJobFailures(scenario.expectedJobFailures));
        expect(
          harness.model.unconsumedExtractionCalls,
          scriptConsumptionMessage(
            "extraction",
            harness.model.unconsumedExtractionCalls,
          ),
        ).toEqual([]);
        expect(
          harness.model.unconsumedAttentionCalls,
          scriptConsumptionMessage(
            "attention",
            harness.model.unconsumedAttentionCalls,
          ),
        ).toEqual([]);

        const actual = harness.outcome();
        if (scenario.defect) {
          expect(
            actual,
            `Known defect "${scenario.defect}" changed its observable outcome; update or remove knownCurrent`,
          ).toMatchObject(scenario.knownCurrent);
          expect(
            actual,
            `Known defect "${scenario.defect}" now satisfies the desired outcome; remove defect and knownCurrent`,
          ).not.toMatchObject(scenario.expect);
        } else {
          expect(actual).toMatchObject(scenario.expect);
        }
      });
    }
  });
}

interface SummarizedJobFailure {
  readonly job: string;
  readonly kind: ModelFailure | "unexpected";
  readonly count: number;
}

function summarizeJobFailures(
  failures: FeedbackLoopHarness["failures"],
): SummarizedJobFailure[] {
  return summarizeFailureEntries(
    failures.map((failure) => ({
      job: failure.job,
      kind: failure.kind ?? ("unexpected" as const),
      count: 1,
    })),
  );
}

function summarizeExpectedJobFailures(
  failures: readonly ExpectedJobFailure[] | undefined,
): SummarizedJobFailure[] {
  return summarizeFailureEntries(failures ?? []);
}

function summarizeFailureEntries(
  failures: readonly SummarizedJobFailure[],
): SummarizedJobFailure[] {
  const counts = new Map<string, SummarizedJobFailure>();
  for (const failure of failures) {
    const key = `${failure.job}\u0000${failure.kind}`;
    const current = counts.get(key);
    counts.set(key, {
      job: failure.job,
      kind: failure.kind,
      count: (current?.count ?? 0) + failure.count,
    });
  }
  return [...counts.values()].sort(
    (left, right) =>
      left.job.localeCompare(right.job) || left.kind.localeCompare(right.kind),
  );
}

function scriptConsumptionMessage(
  script: "extraction" | "attention",
  calls: readonly number[],
): string {
  return calls.length === 0
    ? `${script} script was consumed`
    : `${script} script left ${calls.length} unconsumed turn(s): call ${calls.join(
        ", ",
      )}`;
}
