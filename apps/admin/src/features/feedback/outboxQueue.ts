import type { FeedbackConversationDetailDtoOutputGoalsItemStatus } from "../../api/generated/model/feedbackConversationDetailDtoOutputGoalsItemStatus";
import type { FeedbackOutboxHistoryDtoOutputItemsItemStatus } from "../../api/generated/model/feedbackOutboxHistoryDtoOutputItemsItemStatus";
import type { FeedbackOutboxMessageDeliveryDtoOutput } from "../../api/generated/model/feedbackOutboxMessageDeliveryDtoOutput";
import type { FeedbackOutboxMessageDeliveryDtoOutputDispatch } from "../../api/generated/model/feedbackOutboxMessageDeliveryDtoOutputDispatch";
import type { FeedbackOutboxMessageDeliveryDtoOutputLog } from "../../api/generated/model/feedbackOutboxMessageDeliveryDtoOutputLog";
import type { FeedbackOutboxMessageDeliveryDtoOutputLogConversationState } from "../../api/generated/model/feedbackOutboxMessageDeliveryDtoOutputLogConversationState";
import type { FeedbackOutboxMessageDeliveryDtoOutputLogConversationStateControlSource } from "../../api/generated/model/feedbackOutboxMessageDeliveryDtoOutputLogConversationStateControlSource";
import type { FeedbackOutboxMessageDeliveryDtoOutputLogDecision } from "../../api/generated/model/feedbackOutboxMessageDeliveryDtoOutputLogDecision";
import type { FeedbackOutboxMessageDeliveryDtoOutputLogOrigin } from "../../api/generated/model/feedbackOutboxMessageDeliveryDtoOutputLogOrigin";
import type { FeedbackOutboxQueueDtoOutput } from "../../api/generated/model/feedbackOutboxQueueDtoOutput";
import type { FeedbackOutboxQueueDtoOutputItemsItemCampaignStatus } from "../../api/generated/model/feedbackOutboxQueueDtoOutputItemsItemCampaignStatus";
import type { FeedbackOutboxQueueDtoOutputItemsItemKind } from "../../api/generated/model/feedbackOutboxQueueDtoOutputItemsItemKind";
import type { FeedbackOutboxQueueDtoOutputItemsItemStatus } from "../../api/generated/model/feedbackOutboxQueueDtoOutputItemsItemStatus";
import { formatPreciseTimestamp } from "./conversationView";
import {
  controlLabel,
  goalStatusBadge,
  lifecycleBadge,
  questionLabel,
  QUESTION_KEYS,
  type FeedbackBadge,
} from "./labels";

/**
 * How long a message has been waiting, as the one number this screen exists to
 * show.
 *
 * The thresholds come from the mechanism, not from taste. The dispatcher scans
 * every second, while provider pacing and transport still add real latency.
 * Anything under 15 seconds is ordinary in-flight headroom. Past that, a
 * launched row has survived at least fifteen claim scans; at a minute it has
 * the shape of the 147-second backlog seen in the 2026-07-27 rehearsal rather
 * than a merely slow moment.
 */
export const OUTBOX_WAITING_SLOW_SECONDS = 15;
export const OUTBOX_WAITING_STALLED_SECONDS = 60;

/**
 * How a row's age should read.
 *
 * `parked` is the one that matters most. A row whose campaign is not `launched`
 * is not late — dispatch is deliberately refusing to claim it, and `held` rows
 * are never leased at all. Colouring those red would teach an operator that red
 * means nothing, so age stops carrying urgency the moment the system is doing
 * exactly what it was told.
 */
export type OutboxWaitingTone = "parked" | "fresh" | "slow" | "stalled";

export function outboxWaitingTone(item: {
  status: OutboxQueueState;
  campaignStatus: FeedbackOutboxQueueDtoOutputItemsItemCampaignStatus;
  waitingSeconds: number;
}): OutboxWaitingTone {
  if (item.status === "held" || item.campaignStatus !== "launched") {
    return "parked";
  }
  if (item.waitingSeconds >= OUTBOX_WAITING_STALLED_SECONDS) {
    return "stalled";
  }
  return item.waitingSeconds >= OUTBOX_WAITING_SLOW_SECONDS ? "slow" : "fresh";
}

/**
 * Compact age: `8s`, `2m 27s`, `1h 04m`.
 *
 * Seconds are kept up to an hour because the difference between 40s and 90s is
 * the difference between fine and broken, and "2 minutes ago" hides it.
 */
export function formatWaiting(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  if (total < 60) {
    return `${total}s`;
  }
  if (total < 3600) {
    return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, "0")}s`;
  }
  return `${Math.floor(total / 3600)}h ${String(Math.floor((total % 3600) / 60)).padStart(2, "0")}m`;
}

/**
 * The gap between two steps of one message's delivery.
 *
 * Sub-second resolution up to a second, because that is the whole scale a
 * healthy delivery lives on: written, leased and sent inside the same second is
 * the normal case, and `formatWaiting` would print all three of those gaps as
 * `0s` — three zeros in a column whose only job is to show that nothing was
 * slow. Past a minute the milliseconds have stopped meaning anything and the
 * screen's compact form takes over.
 */
export function formatDelta(milliseconds: number): string {
  const total = Math.max(0, milliseconds);
  if (total < 1000) {
    return `+${Math.round(total)}ms`;
  }
  if (total < 60_000) {
    return `+${(total / 1000).toFixed(1)}s`;
  }
  return `+${formatWaiting(Math.floor(total / 1000))}`;
}

/** Spoken form for a screen reader, where `2m 27s` reads as punctuation. */
export function describeWaiting(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  if (total < 60) {
    return `${total} ${total === 1 ? "second" : "seconds"}`;
  }
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  const minutePart = `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  return rest === 0
    ? minutePart
    : `${minutePart} ${rest} ${rest === 1 ? "second" : "seconds"}`;
}

export type OutboxQueueState = FeedbackOutboxQueueDtoOutputItemsItemStatus;

const OUTBOX_STATUS_BADGES = {
  pending: "Queued",
  claimed: "Claimed",
  attempting: "Sending",
  ambiguous: "Reconciliation required",
  sending: "Sending",
  held: "Held",
} as const satisfies Record<OutboxQueueState, string>;

/**
 * The row's own status as a labelled badge.
 *
 * `pending` reads as "Queued" rather than "Pending" because dispatch has not
 * claimed it yet — from the participant's side nothing has started. Tone is
 * reinforcement; the word carries the meaning.
 */
export function outboxStatusBadge(status: OutboxQueueState): FeedbackBadge {
  return {
    key: "outbox-status",
    label: OUTBOX_STATUS_BADGES[status],
    tone:
      status === "ambiguous"
        ? "danger"
        : status === "held"
          ? "warning"
          : status === "sending" ||
              status === "claimed" ||
              status === "attempting"
            ? "info"
            : "neutral",
  };
}

const OUTBOX_KIND_LABELS: Record<
  FeedbackOutboxQueueDtoOutputItemsItemKind,
  string
> = {
  intro: "Intro",
  reply: "Reply",
  reminder: "Reminder",
  staff: "Staff message",
  system: "System",
};

export function outboxKindLabel(
  kind: FeedbackOutboxQueueDtoOutputItemsItemKind,
): string {
  return OUTBOX_KIND_LABELS[kind];
}

export type OutboxDispatchState =
  FeedbackOutboxMessageDeliveryDtoOutputDispatch["state"];

/** Durable dispatcher facts; no Redis job identity or private claim token. */
export type OutboxDispatchStatus =
  FeedbackOutboxMessageDeliveryDtoOutputDispatch;

export interface DeliveryActivityLines {
  /** Durable dispatcher state, always present. */
  state: string;
  /** What the state means for delivery and recovery. */
  explanation: string;
  /** Attempt line, or null when nothing durable records an attempt. */
  attempt: string | null;
  /** Claim deadline or provider-attempt start, when one exists. */
  timing: string | null;
  /** Last durable reason/error, labelled for display when present. */
  recordedReason: string | null;
  tone: "none" | "pending" | "danger";
}

/**
 * Operator copy over PostgreSQL dispatch state.
 */
export function deliveryActivityLines(
  dispatch: OutboxDispatchStatus,
  now: Date = new Date(),
): DeliveryActivityLines {
  const copy = DURABLE_DISPATCH_COPY[dispatch.state];
  const attempt = dispatchAttemptLine(dispatch);
  const timing =
    dispatch.state === "claimed" && dispatch.claimExpiresAt
      ? `The safe claim expires at ${formatPreciseTimestamp(dispatch.claimExpiresAt, now)} and may then be reclaimed.`
      : dispatch.sendStartedAt &&
          (dispatch.state === "attempting" ||
            dispatch.state === "ambiguous" ||
            dispatch.state === "sent" ||
            dispatch.state === "failed")
        ? `Provider attempt started at ${formatPreciseTimestamp(dispatch.sendStartedAt, now)}.`
        : null;

  return {
    ...copy,
    attempt,
    timing,
    recordedReason: dispatch.lastError
      ? `Recorded reason: ${dispatch.lastError}`
      : null,
  };
}

function dispatchAttemptLine(dispatch: OutboxDispatchStatus): string {
  if (dispatch.attemptCount === 1) {
    return "1 provider attempt is recorded durably.";
  }
  if (dispatch.attemptCount > 1) {
    return `${dispatch.attemptCount} provider attempts are recorded durably.`;
  }
  if (
    dispatch.state === "sending" ||
    dispatch.state === "sent" ||
    (dispatch.state === "ambiguous" &&
      dispatch.lastError === "legacy_sending_cutover_ambiguous")
  ) {
    return "This pre-cutover row has no durable attempt count.";
  }
  return "No provider attempt is recorded.";
}

const DURABLE_DISPATCH_COPY = {
  pending: {
    state: "Pending",
    explanation:
      "The durable row is waiting to be claimed when current state allows.",
    tone: "none",
  },
  claimed: {
    state: "Claimed",
    explanation:
      "A dispatcher holds a safe lease; no provider attempt has started yet.",
    tone: "none",
  },
  attempting: {
    state: "Attempting delivery",
    explanation:
      "The provider attempt has started. This row is not automatically reclaimed or resent from here.",
    tone: "pending",
  },
  ambiguous: {
    state: "Needs reconciliation",
    explanation:
      "The provider may have accepted this message. Automatic resend is blocked until the outcome is reconciled.",
    tone: "danger",
  },
  sending: {
    state: "Legacy delivery",
    explanation:
      "A pre-cutover delivery worker may still own this row. The dispatcher observes it but does not reclaim it as pending work.",
    tone: "pending",
  },
  sent: {
    state: "Sent",
    explanation: "A successful provider send is recorded durably.",
    tone: "none",
  },
  failed: {
    state: "Failed",
    explanation:
      "Dispatch ended with a definitive failure and will not retry automatically.",
    tone: "danger",
  },
  held: {
    state: "Held",
    explanation: "This row is deliberately parked and is not dispatchable.",
    tone: "none",
  },
  cancelled: {
    state: "Cancelled",
    explanation: "This row was cancelled before delivery.",
    tone: "none",
  },
} as const satisfies Record<
  OutboxDispatchState,
  Pick<DeliveryActivityLines, "state" | "explanation" | "tone">
>;

export type OutboxHistoryState = FeedbackOutboxHistoryDtoOutputItemsItemStatus;

const OUTBOX_HISTORY_STATUS_LABELS: Record<OutboxHistoryState, string> = {
  pending: "Queued",
  claimed: "Claimed",
  attempting: "Sending",
  ambiguous: "Reconciliation required",
  sending: "Sending",
  held: "Held",
  sent: "Sent",
  failed: "Failed",
  cancelled: "Cancelled",
};

/**
 * The history row's status badge. Terminal rows are the point of this list, so
 * `sent` earns the quiet success tone and `failed` the loud one; undelivered
 * statuses keep exactly the queue list's colouring so the same
 * word never changes meaning between the two views.
 */
export function outboxHistoryStatusBadge(
  status: OutboxHistoryState,
): FeedbackBadge {
  return {
    key: "outbox-status",
    label: OUTBOX_HISTORY_STATUS_LABELS[status],
    tone:
      status === "failed" || status === "ambiguous"
        ? "danger"
        : status === "sent"
          ? "success"
          : status === "held"
            ? "warning"
            : status === "sending" ||
                status === "claimed" ||
                status === "attempting"
              ? "info"
              : "neutral",
  };
}

/**
 * The decision that produced this row, and the conversation the writer was
 * looking at when it made it.
 *
 * The queue answers «has this arrived». The log answers the question an
 * operator asks next and could not answer at all until now: «why was this
 * written, and what did the system think was going on». It is durable
 * PostgreSQL, written in the same transaction as the outbox row, so it sits
 * beside the row's own facts as part of the same durable record.
 */
export type OutboundDecisionLog =
  NonNullable<FeedbackOutboxMessageDeliveryDtoOutputLog>;

/**
 * What the pane says for a row enqueued before `message_outbox_log` existed.
 *
 * Stated rather than hidden. An empty section teaches an operator that the
 * decision log is unreliable; this says the record is simply older than the
 * table, which is a fact about the row and not about the system today.
 */
export const OUTBOX_LOG_ABSENT_COPY =
  "This row was queued before the decision log existed, so nothing was recorded about why it was sent or what the conversation looked like at the time.";

/**
 * Which mark belongs beside a model id.
 *
 * The log records whatever id the extractor asked for, and most of them arrive
 * through OpenRouter — `qwen/…`, `google/…`, and `openai/…` ids that were
 * routed too — so the prefix is the only provider fact the record carries.
 * OpenAI is the one mark drawn beside a model here; everything else takes a
 * neutral glyph, because a logo drawn on another company's behalf would be a
 * claim about provenance this record cannot support.
 */
export type OutboundModelProvider = "openai" | "generic";

export function outboundModelProvider(model: string): OutboundModelProvider {
  return model.toLowerCase().startsWith("openai/") ? "openai" : "generic";
}

/**
 * One labelled fact of the log, rendered in the pane's own detail rows.
 *
 * `kind` is the fact's own nature rather than a style: a correlation id is an
 * id wherever it appears, and the pane alone decides what an id looks like.
 * Naming it here is what lets this module stay React-free while the opened row
 * still renders a model pill, a fill bar or a copyable id — and it keeps every
 * one of those decisions assertable in a unit test.
 *
 * `value` is always the string an operator reads, so a fact whose kind the
 * pane has no special treatment for still renders as the truth.
 */
export type OutboundLogFact = {
  /** Unique within its group, so it doubles as the React key. */
  label: string;
  value: string;
} & (
  | { kind: "text" }
  | { kind: "id" }
  | { kind: "timestamp" }
  | { kind: "model"; provider: OutboundModelProvider }
  | {
      kind: "confidence";
      /** 0–1 exactly as the model reported it; null when it reported none. */
      ratio: number | null;
    }
);

const OUTBOUND_ORIGIN_LABELS: Record<
  FeedbackOutboxMessageDeliveryDtoOutputLogOrigin,
  string
> = {
  extraction_reply: "Model reply",
  extraction_fallback_fence: "Fallback fence",
  extraction_fallback_ack: "Fallback acknowledgement",
  extraction_parked_notice: "Parked notice",
  stop_ack: "STOP acknowledgement",
  media_notice: "Media notice",
  staff_message: "Staff message",
  campaign_intro: "Campaign intro",
  reminder: "Reminder",
};

export function outboundOriginLabel(
  origin: FeedbackOutboxMessageDeliveryDtoOutputLogOrigin,
): string {
  return OUTBOUND_ORIGIN_LABELS[origin];
}

/**
 * Why extraction gave up, in the operator's words.
 *
 * The cause is free text in the log on purpose — the record has to survive the
 * extractor renaming its own classes — so an unrecognised cause is passed
 * through verbatim instead of being flattened into «unknown». `unknown` itself
 * is the extractor's own word for a failure that matched no class, which is the
 * same «άγνωστο» this screen already uses for a fact nobody can recover.
 */
const EXTRACTION_CAUSE_TEXT: Record<string, string> = {
  provider_refusal: "the provider declined to answer",
  provider_error: "the provider was unreachable or erroring",
  validation_failed: "no response satisfied the agreed schema",
  unknown: "άγνωστο — the failure matched no known class",
};

function extractionCauseText(cause: string): string {
  return EXTRACTION_CAUSE_TEXT[cause] ?? cause;
}

const GOAL_STATUSES: readonly FeedbackConversationDetailDtoOutputGoalsItemStatus[] =
  ["pending", "asked", "answered", "skipped"];

/** The inbox's own goal vocabulary, tolerant of a status the log outlived. */
function goalStatusText(status: string): string {
  const known = GOAL_STATUSES.find((candidate) => candidate === status);
  return known === undefined
    ? status
    : goalStatusBadge(known).label.toLowerCase();
}

function goalKeyText(key: string): string {
  const known = QUESTION_KEYS.find((candidate) => candidate === key);
  return known === undefined ? key : questionLabel(known);
}

/**
 * Goals as counts — «2 answered · 1 not asked» — rather than one row per goal.
 *
 * Four goals spelled out one per line would be the largest block in a pane
 * whose subject is a delivery, for a fact the conversation screen owns in full.
 * The counts are what say whether the questionnaire was under way.
 */
function summarizeGoals(goals: readonly { status: string }[]): string {
  if (goals.length === 0) {
    return "none";
  }
  const counts = new Map<string, number>();
  for (const goal of goals) {
    const text = goalStatusText(goal.status);
    counts.set(text, (counts.get(text) ?? 0) + 1);
  }
  return [...counts].map(([text, count]) => `${count} ${text}`).join(" · ");
}

function decisionDetailFacts(
  decision: FeedbackOutboxMessageDeliveryDtoOutputLogDecision,
): OutboundLogFact[] {
  switch (decision.origin) {
    case "extraction_reply": {
      const facts: OutboundLogFact[] = [
        {
          label: "Model",
          kind: "model",
          value: decision.model,
          provider: outboundModelProvider(decision.model),
        },
        {
          label: "Confidence",
          kind: "confidence",
          ratio: decision.confidence,
          value:
            decision.confidence === null
              ? "not reported"
              : `${Math.round(decision.confidence * 100)}%`,
        },
        {
          label: "Asked",
          kind: "text",
          value:
            decision.askedGoal === null
              ? "nothing — it asked no question"
              : goalKeyText(decision.askedGoal),
        },
      ];
      if (decision.closingReason !== null) {
        facts.push({
          label: "Closed the thread",
          kind: "text",
          value: lifecycleBadge({
            state: "closed",
            reason: decision.closingReason,
          }).label,
        });
      }
      facts.push({
        label: "Goals it recorded",
        kind: "text",
        value: summarizeGoals(decision.goalStatuses),
      });
      return facts;
    }
    case "extraction_fallback_fence":
    case "extraction_fallback_ack":
    case "extraction_parked_notice":
      return [
        {
          label: "Cause",
          kind: "text",
          value: extractionCauseText(decision.cause),
        },
      ];
    case "stop_ack":
    case "media_notice":
      return [
        {
          label: "From inbound message",
          kind: "id",
          value: decision.sourceIngressId,
        },
      ];
    case "staff_message":
      return [staffActorFact(decision.staffActorId)];
    case "campaign_intro":
      return [
        {
          label: "Conversation",
          kind: "text",
          value: decision.conversationCreated
            ? "created with this message"
            : "already existed",
        },
      ];
    case "reminder":
      return [{ label: "Rung", kind: "text", value: String(decision.rung) }];
  }
}

/**
 * Who wrote a staff message.
 *
 * The column holds whatever identified the actor at the time — a Clerk user id
 * in production, but it is free text, and older rows carry a name. An id earns
 * the copyable, truncated treatment; a name must not, because truncating
 * «Μαρία Παπαδοπούλου» to its first eight characters would destroy the one
 * thing that makes it readable.
 */
function staffActorFact(staffActorId: string): OutboundLogFact {
  const looksLikeAnId = !/\s/u.test(staffActorId) && staffActorId.length > 12;
  return {
    label: "Written by",
    kind: looksLikeAnId ? "id" : "text",
    value: staffActorId,
  };
}

/**
 * What was decided, in the order an operator reads it: what wrote this, what
 * that decision turned on, when it was recorded and the id that ties it to the
 * backend's own logs.
 */
export function outboundDecisionFacts(
  log: OutboundDecisionLog,
  now: Date = new Date(),
): OutboundLogFact[] {
  return [
    { label: "Origin", kind: "text", value: outboundOriginLabel(log.origin) },
    ...decisionDetailFacts(log.decision),
    {
      label: "Recorded",
      kind: "timestamp",
      value: formatPreciseTimestamp(log.createdAt, now),
    },
    { label: "Correlation id", kind: "id", value: log.correlationId },
  ];
}

const CONTROL_SOURCE_TEXT: Record<
  FeedbackOutboxMessageDeliveryDtoOutputLogConversationStateControlSource,
  string
> = {
  launch: "since launch",
  staff_action: "after a staff action",
  external_outbound: "after an outbound message from elsewhere",
};

function attentionText(
  state: FeedbackOutboxMessageDeliveryDtoOutputLogConversationState,
): string {
  const flagged =
    state.needsAttention || state.unresolvedAttentionCount > 0
      ? `Flagged (${state.unresolvedAttentionCount} unresolved)`
      : null;
  if (flagged === null) {
    return state.awaitingHuman ? "Waiting on a person" : "None";
  }
  return state.awaitingHuman ? `${flagged} · waiting on a person` : flagged;
}

/**
 * The conversation as the writer saw it, which is not the same thing as the
 * conversation now — the snapshot is taken from the document the decision was
 * made against, before that run's own effects were applied. That is exactly
 * what makes it worth keeping: it is the only record of what the system
 * believed at the moment it chose to send this.
 */
export function outboundConversationStateFacts(
  state: FeedbackOutboxMessageDeliveryDtoOutputLogConversationState,
): OutboundLogFact[] {
  return [
    {
      label: "Lifecycle",
      kind: "text",
      value: lifecycleBadge(state.lifecycle).label,
    },
    {
      label: "Control",
      kind: "text",
      value: `${controlLabel(state.control.mode)} ${CONTROL_SOURCE_TEXT[state.control.source]}`,
    },
    { label: "Goals", kind: "text", value: summarizeGoals(state.goals) },
    { label: "Attention", kind: "text", value: attentionText(state) },
    {
      label: "Messages",
      kind: "text",
      value:
        state.latestMessageSeq === null
          ? String(state.messageCount)
          : `${state.messageCount}, latest #${state.latestMessageSeq}`,
    },
    {
      label: "Extraction cursor",
      kind: "text",
      value:
        state.extractionCursorSeq === 0
          ? "nothing read yet"
          : `#${state.extractionCursorSeq}`,
    },
    {
      label: "Reminders",
      kind: "text",
      value:
        state.reminderCount === 0 ? "none sent" : `${state.reminderCount} sent`,
    },
  ];
}

/**
 * One thing that happened to a message, and how long after the last one.
 *
 * The pane used to print six labelled timestamps in a stack — «Created», «Row
 * last changed», «Delivery last changed», «Sent», «Delivered», «Read» — of
 * which two were the same instant and two were usually an em dash. What an
 * operator reads that stack to find is never the absolute time; it is the
 * distance between two of them. So the distance is what this publishes, and
 * steps that did not happen are simply not steps.
 */
export interface OutboundDeliveryStep {
  /** Unique within the timeline, so it doubles as the React key. */
  key: string;
  label: string;
  /** The instant itself, already formatted to the millisecond. */
  at: string;
  /** Time since the previous step; null on the first, which has no previous. */
  sincePrevious: string | null;
  /** True for a step that records a stop rather than progress. */
  terminal: boolean;
}

interface DeliveryTimelineMessage {
  createdAt: string;
  updatedAt: string;
  sentAt: string | null;
  deliveredAt: string | null;
  readAt: string | null;
  playedAt: string | null;
  status: OutboxHistoryState;
}

export interface DeliveryTimelineInput {
  message: DeliveryTimelineMessage;
  dispatch: OutboxDispatchStatus;
}

/**
 * What actually happened to this message, in order, with the gaps.
 *
 * `sendStartedAt` marks the irreversible provider boundary and `updatedAt` is
 * used only for a terminal state with no more specific timestamp.
 *
 * The steps are sorted by their own instant rather than trusted in the order
 * they are assembled — a row that failed after a provider call has an
 * `updatedAt` later than its `sentAt`, and a timeline that printed them the
 * other way round would invent a negative gap.
 */
export function outboundDeliveryTimeline(
  input: DeliveryTimelineInput,
  now: Date = new Date(),
): OutboundDeliveryStep[] {
  const message = input.message;
  const dispatchState = input.dispatch.state;
  const candidates: {
    key: string;
    label: string;
    iso: string | null;
    terminal: boolean;
  }[] = [
    {
      key: "created",
      label: "Written",
      iso: message.createdAt,
      terminal: false,
    },
    {
      key: "attempt-started",
      label: "Provider attempt started",
      iso: input.dispatch.sendStartedAt,
      terminal: false,
    },
    { key: "sent", label: "Sent", iso: message.sentAt, terminal: false },
    {
      key: "delivered",
      label: "Delivered",
      iso: message.deliveredAt,
      terminal: false,
    },
    { key: "read", label: "Read", iso: message.readAt, terminal: false },
    { key: "played", label: "Played", iso: message.playedAt, terminal: false },
    {
      key: "failed",
      label: "Failed",
      iso: dispatchState === "failed" ? message.updatedAt : null,
      terminal: true,
    },
    {
      key: "ambiguous",
      label: "Needs reconciliation",
      iso: dispatchState === "ambiguous" ? message.updatedAt : null,
      terminal: true,
    },
    {
      key: "cancelled",
      label: "Cancelled",
      iso: dispatchState === "cancelled" ? message.updatedAt : null,
      terminal: true,
    },
  ];

  const happened = candidates
    .filter(
      (candidate): candidate is typeof candidate & { iso: string } =>
        candidate.iso !== null,
    )
    .map((candidate) => ({ ...candidate, time: new Date(candidate.iso) }))
    .sort((left, right) => left.time.getTime() - right.time.getTime());

  return happened.map((step, index) => {
    const previous = happened[index - 1];
    return {
      key: step.key,
      label: step.label,
      at: formatPreciseTimestamp(step.iso, now),
      sincePrevious:
        previous === undefined
          ? null
          : formatDelta(step.time.getTime() - previous.time.getTime()),
      terminal: step.terminal,
    };
  });
}

/**
 * The provider's own reading, but only when the timeline does not already say
 * it.
 *
 * `message_outbox` carries two statuses and the pane used to print both as raw
 * enum values in adjacent rows — `sent` above `delivered`, which reads like a
 * contradiction and is not one. Four of the six delivery statuses are exactly
 * the steps the timeline now draws with their times attached, so repeating them
 * as a word without a time is strictly less information in more space.
 *
 * The two that survive are the two the timeline cannot draw, because neither
 * has a timestamp of its own: a provider that reported an error, and a provider
 * that has not reported anything back yet.
 */
export function outboxProviderReadingBadge(
  deliveryStatus: FeedbackOutboxMessageDeliveryDtoOutput["deliveryStatus"],
): FeedbackBadge | null {
  if (deliveryStatus === "error") {
    return {
      key: "provider-reading",
      label: "Provider reported an error",
      tone: "danger",
    };
  }
  if (deliveryStatus === "pending") {
    return {
      key: "provider-reading",
      label: "Provider has not confirmed",
      tone: "neutral",
    };
  }
  return null;
}

/**
 * How far back the history reaches.
 *
 * Presets rather than two date pickers: every question anybody has actually
 * asked this log — «what broke in the last hour», «what did we send today»,
 * «has this been happening all week» — is one of these, and a pair of pickers
 * makes the common case cost six interactions to answer.
 */
export type OutboxHistoryRangeKey = "hour" | "today" | "week" | "all";

export const OUTBOX_HISTORY_RANGES: readonly {
  key: OutboxHistoryRangeKey;
  label: string;
}[] = [
  { key: "hour", label: "Last hour" },
  { key: "today", label: "Today" },
  { key: "week", label: "7 days" },
  { key: "all", label: "All" },
];

export function isOutboxHistoryRangeKey(
  value: string | null,
): value is OutboxHistoryRangeKey {
  return OUTBOX_HISTORY_RANGES.some((range) => range.key === value);
}

/**
 * The instant a range starts, or undefined for «all», which sends no bound.
 *
 * Computed against the *browser's* clock and the operator's own midnight. Every
 * other time on this screen is measured on the server on purpose — an age is a
 * measurement and a skewed client would misreport it — but a range is not a
 * measurement, it is a question, and «today» is a question about the day the
 * person asking is having.
 */
export function outboxHistoryRangeFrom(
  key: OutboxHistoryRangeKey,
  now: Date = new Date(),
): string | undefined {
  switch (key) {
    case "hour":
      return new Date(now.getTime() - 3_600_000).toISOString();
    case "today": {
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      return start.toISOString();
    }
    case "week":
      return new Date(now.getTime() - 7 * 86_400_000).toISOString();
    case "all":
      return undefined;
  }
}

/**
 * The status filter's options, «any» first.
 *
 * The vocabulary is `outboxHistoryStatusBadge`'s, not a second one: a word must
 * not mean one thing in the filter and another on the row it selects.
 */
export const OUTBOX_HISTORY_STATUS_FILTERS: readonly {
  key: FeedbackOutboxHistoryDtoOutputItemsItemStatus | "any";
  label: string;
}[] = [
  { key: "any", label: "Any status" },
  ...(
    Object.keys(
      OUTBOX_HISTORY_STATUS_LABELS,
    ) as FeedbackOutboxHistoryDtoOutputItemsItemStatus[]
  ).map((status) => ({
    key: status,
    label: OUTBOX_HISTORY_STATUS_LABELS[status],
  })),
];

export function isOutboxHistoryStatus(
  value: string | null,
): value is FeedbackOutboxHistoryDtoOutputItemsItemStatus {
  return value !== null && value in OUTBOX_HISTORY_STATUS_LABELS;
}

export interface OutboxQueueSummary {
  total: number;
  held: number;
  /** Age of the oldest waiting message; null when nothing is waiting. */
  oldestWaitingSeconds: number | null;
  /** Highest severity present, for the summary's own tone. */
  worstTone: OutboxWaitingTone;
}

/**
 * The at-a-glance line. `items` is ordered oldest first by the endpoint, so the
 * oldest age is the head of the list even when the page is capped.
 */
export function outboxQueueSummary(
  view: FeedbackOutboxQueueDtoOutput,
): OutboxQueueSummary {
  const tones = view.items.map((item) => outboxWaitingTone(item));
  return {
    total: view.counts.total,
    held: view.counts.held,
    oldestWaitingSeconds: view.items[0]?.waitingSeconds ?? null,
    worstTone: tones.includes("stalled")
      ? "stalled"
      : tones.includes("slow")
        ? "slow"
        : tones.includes("fresh")
          ? "fresh"
          : "parked",
  };
}
