import type { FeedbackConversationDetailDtoOutputGoalsItemStatus } from "../../api/generated/model/feedbackConversationDetailDtoOutputGoalsItemStatus";
import type { FeedbackOutboxHistoryDtoOutputItemsItemStatus } from "../../api/generated/model/feedbackOutboxHistoryDtoOutputItemsItemStatus";
import type { FeedbackOutboxMessageDeliveryDtoOutput } from "../../api/generated/model/feedbackOutboxMessageDeliveryDtoOutput";
import type { FeedbackOutboxMessageDeliveryDtoOutputJobState } from "../../api/generated/model/feedbackOutboxMessageDeliveryDtoOutputJobState";
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
 * The thresholds come from the mechanism, not from taste. The outbox relay runs
 * every 5 seconds, so anything under 15 seconds has had at most two chances to
 * be picked up and is simply in flight. Past 15 seconds it has missed three
 * relay passes, which means something is holding a worker slot. The 2026-07-27
 * rehearsal sat at 147 seconds, so a minute is already the shape of that
 * incident rather than a slow moment.
 */
export const OUTBOX_WAITING_SLOW_SECONDS = 15;
export const OUTBOX_WAITING_STALLED_SECONDS = 60;

/**
 * How a row's age should read.
 *
 * `parked` is the one that matters most. A row whose campaign is not `launched`
 * is not late — the relay is deliberately refusing to lease it, and `held` rows
 * are never leased at all. Colouring those red would teach an operator that red
 * means nothing, so age stops carrying urgency the moment the system is doing
 * exactly what it was told.
 */
export type OutboxWaitingTone = "parked" | "fresh" | "slow" | "stalled";

export function outboxWaitingTone(item: {
  status: FeedbackOutboxQueueDtoOutputItemsItemStatus;
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

const OUTBOX_STATUS_LABELS: Record<
  FeedbackOutboxQueueDtoOutputItemsItemStatus,
  string
> = {
  pending: "Queued",
  sending: "Sending",
  held: "Held",
};

/**
 * The row's own status as a labelled badge.
 *
 * `pending` reads as "Queued" rather than "Pending" because the relay has not
 * taken it yet — from the participant's side nothing has started. Tone is
 * reinforcement; the word carries the meaning.
 */
export function outboxStatusBadge(
  status: FeedbackOutboxQueueDtoOutputItemsItemStatus,
): FeedbackBadge {
  return {
    key: "outbox-status",
    label: OUTBOX_STATUS_LABELS[status],
    tone:
      status === "held" ? "warning" : status === "sending" ? "info" : "neutral",
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

/**
 * What Redis said about the delivery job, in words.
 *
 * «άγνωστο» is the Greek the extraction status block already uses for a queue
 * fact that cannot be recovered, and it is the honest label here far more often
 * than it looks: delivery jobs carry `attempts: 1` with immediate
 * `removeOnComplete` / `removeOnFail`, so the job exists only while it is
 * actually queued or running.
 */
const JOB_STATE_LABELS: Record<
  FeedbackOutboxMessageDeliveryDtoOutputJobState,
  string
> = {
  waiting: "Waiting for a worker",
  "waiting-children": "Waiting for a worker",
  prioritized: "Waiting for a worker",
  delayed: "Delayed",
  active: "Being sent now",
  completed: "Finished",
  failed: "Failed",
  unknown: "άγνωστο",
};

export function deliverJobStateLabel(
  state: FeedbackOutboxMessageDeliveryDtoOutputJobState,
): string {
  return JOB_STATE_LABELS[state];
}

export interface DeliverJobLines {
  /** The state, always present, `«άγνωστο»` included. */
  state: string;
  /**
   * Why that state is what it is — including, for `unknown`, which mutually
   * indistinguishable situations produced it. Never a diagnosis we cannot make.
   */
  explanation: string;
  /** Attempt line, or null when nothing durable records an attempt. */
  attempt: string | null;
  /** A time, when there is one to give: due, started, or nothing. */
  timing: string | null;
  failure: string | null;
  tone: "none" | "pending" | "danger";
}

/**
 * The opened row's job block, written so that no line can be read as a claim
 * the system cannot support.
 *
 * There is no attempts table. `message_outbox` has no attempt counter, no
 * `message_outbox_attempts` exists, and BullMQ's own counter restarts because
 * the job id is re-added on the next relay lease. So "how many times has this
 * been tried" is answered with the one durable fact there is: whether a
 * provider call left its id behind.
 */
export function deliverJobLines(
  message: FeedbackOutboxMessageDeliveryDtoOutput,
  now: Date = new Date(),
): DeliverJobLines {
  const job = message.job;
  const providerAttempted =
    message.providerLogId !== null || message.providerMessageId !== null;

  const attempt = providerAttempted
    ? "A provider call was made — its id is recorded, so recovery reconciles instead of sending again."
    : job.attemptsMade === null
      ? null
      : `Attempt ${job.attemptsMade + 1} of ${job.attemptsAllowed ?? 1}. BullMQ retries delivery no further; PostgreSQL owns recovery.`;

  // One clock for the whole pane. The row's own times are read to the
  // millisecond, and a job line an operator compares them against — «picked up
  // at» against «row last changed» — cannot be a minute wide or the comparison
  // is the formatting's, not the system's.
  let timing: string | null = null;
  if (job.dueAt !== null) {
    timing = `Runs at ${formatPreciseTimestamp(job.dueAt, now)}.`;
  } else if (job.startedAt !== null) {
    timing = `Picked up at ${formatPreciseTimestamp(job.startedAt, now)}.`;
  } else if (job.enqueuedAt !== null) {
    timing = `Queued at ${formatPreciseTimestamp(job.enqueuedAt, now)}.`;
  } else if (message.reclaimAt !== null) {
    // No job and no times, but the row is leased: the relay's recovery horizon
    // is the only real time left to give, and it is better than a spinner.
    timing = `The relay reclaims this row at ${formatPreciseTimestamp(message.reclaimAt, now)} if nothing reports back.`;
  }

  return {
    state: deliverJobStateLabel(job.state),
    explanation: jobExplanation(message),
    attempt,
    timing,
    failure: job.failedReason,
    tone:
      job.state === "failed" || message.deliveryStatus === "error"
        ? "danger"
        : job.state === "unknown" && message.status === "sending"
          ? "pending"
          : "none",
  };
}

function jobExplanation(
  message: FeedbackOutboxMessageDeliveryDtoOutput,
): string {
  if (message.job.state !== "unknown") {
    return "Read live from the delivery queue.";
  }
  if (message.status === "held") {
    return "A held row is never handed to the relay, so no delivery job exists for it.";
  }
  if (message.status === "pending") {
    return message.campaignStatus === "launched"
      ? "Nothing is queued yet — the relay leases pending rows every few seconds."
      : "The campaign is not running, so the relay leaves this row alone.";
  }
  if (message.status === "sending") {
    return "The row is leased but Redis holds no job for it. Retention removal, a finished job and a lost one look the same here.";
  }
  return "This row is finished, and its job was removed when it ended.";
}

const OUTBOX_HISTORY_STATUS_LABELS: Record<
  FeedbackOutboxHistoryDtoOutputItemsItemStatus,
  string
> = {
  pending: "Queued",
  sending: "Sending",
  held: "Held",
  sent: "Sent",
  failed: "Failed",
  cancelled: "Cancelled",
};

/**
 * The history row's status badge. Terminal rows are the point of this list, so
 * `sent` earns the quiet success tone and `failed` the loud one; the three
 * undelivered statuses keep exactly the queue list's colouring so the same
 * word never changes meaning between the two views.
 */
export function outboxHistoryStatusBadge(
  status: FeedbackOutboxHistoryDtoOutputItemsItemStatus,
): FeedbackBadge {
  return {
    key: "outbox-status",
    label: OUTBOX_HISTORY_STATUS_LABELS[status],
    tone:
      status === "failed"
        ? "danger"
        : status === "sent"
          ? "success"
          : status === "held"
            ? "warning"
            : status === "sending"
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
 * beside the row's own facts rather than with the live job read.
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

export interface OutboxQueueSummary {
  total: number;
  pending: number;
  sending: number;
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
    pending: view.counts.pending,
    sending: view.counts.sending,
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
