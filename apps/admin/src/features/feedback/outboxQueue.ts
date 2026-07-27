import type { FeedbackOutboxMessageDeliveryDtoOutput } from "../../api/generated/model/feedbackOutboxMessageDeliveryDtoOutput";
import type { FeedbackOutboxMessageDeliveryDtoOutputJobState } from "../../api/generated/model/feedbackOutboxMessageDeliveryDtoOutputJobState";
import type { FeedbackOutboxQueueDtoOutput } from "../../api/generated/model/feedbackOutboxQueueDtoOutput";
import type { FeedbackOutboxQueueDtoOutputItemsItemCampaignStatus } from "../../api/generated/model/feedbackOutboxQueueDtoOutputItemsItemCampaignStatus";
import type { FeedbackOutboxQueueDtoOutputItemsItemKind } from "../../api/generated/model/feedbackOutboxQueueDtoOutputItemsItemKind";
import type { FeedbackOutboxQueueDtoOutputItemsItemStatus } from "../../api/generated/model/feedbackOutboxQueueDtoOutputItemsItemStatus";
import { formatTimestamp } from "./conversationView";
import type { FeedbackBadge } from "./labels";

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

  let timing: string | null = null;
  if (job.dueAt !== null) {
    timing = `Runs at ${formatTimestamp(job.dueAt, now)}.`;
  } else if (job.startedAt !== null) {
    timing = `Picked up at ${formatTimestamp(job.startedAt, now)}.`;
  } else if (job.enqueuedAt !== null) {
    timing = `Queued at ${formatTimestamp(job.enqueuedAt, now)}.`;
  } else if (message.reclaimAt !== null) {
    // No job and no times, but the row is leased: the relay's recovery horizon
    // is the only real time left to give, and it is better than a spinner.
    timing = `The relay reclaims this row at ${formatTimestamp(message.reclaimAt, now)} if nothing reports back.`;
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
