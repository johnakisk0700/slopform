import type { Queue } from "bullmq";

import { createFeedbackDeliverJobId } from "../jobs.schemas.js";

/**
 * Every state one `feedback.deliver.v1` job can be reported in.
 *
 * BullMQ's own `JobState` plus `unknown`, which is the answer for a job id
 * Redis no longer holds. `unknown` is deliberately not collapsed into a
 * friendlier word: see {@link inspectFeedbackDeliverJob}.
 */
export const FEEDBACK_DELIVER_JOB_STATES = [
  "waiting",
  "waiting-children",
  "prioritized",
  "delayed",
  "active",
  "completed",
  "failed",
  "unknown",
] as const;

export type FeedbackDeliverJobState =
  (typeof FEEDBACK_DELIVER_JOB_STATES)[number];

/**
 * What Redis can prove about the delivery job for one outbox row.
 *
 * Everything here is `null` when the job is gone, because there is nothing to
 * read — not because nothing happened.
 */
export interface FeedbackDeliverJobInspection {
  readonly jobId: string;
  readonly state: FeedbackDeliverJobState;
  /** BullMQ's completed-attempt counter, which resets when the id is re-added. */
  readonly attemptsMade: number | null;
  /** `opts.attempts`; `1` under `OUTBOX_RELAY_JOB_OPTIONS`. */
  readonly attemptsAllowed: number | null;
  readonly enqueuedAt: Date | null;
  /** When a `delayed` job becomes runnable. Null in every other state. */
  readonly dueAt: Date | null;
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
  readonly failedReason: string | null;
}

/**
 * Inspect the single `feedback.deliver.v1` job for one outbox row.
 *
 * One `getJob` plus one `getState` — the whole Redis cost of opening a row.
 * The list endpoint must never call this per row; see
 * [api-contract](../../../../../../docs/backend/mechanisms/api-contract.md).
 *
 * **`unknown` is the ordinary answer, not an alarm.** Delivery jobs are added
 * with `OUTBOX_RELAY_JOB_OPTIONS`: `attempts: 1` and immediate
 * `removeOnComplete` / `removeOnFail`. So the job exists only between the
 * relay's lease and the consumer's last line, and three very different
 * situations produce the same empty read — a `pending` row the relay has not
 * leased yet, a job that finished microseconds ago, and a job that was lost.
 * PostgreSQL is what tells those apart (`status`, `delivery_status`, the
 * provider ids and the five-minute `sending` recovery horizon), so the caller
 * reports both halves and never invents a verdict from this one.
 */
export async function inspectFeedbackDeliverJob(
  queue: Pick<Queue, "getJob">,
  outboxId: string,
): Promise<FeedbackDeliverJobInspection> {
  const jobId = createFeedbackDeliverJobId(outboxId);
  const job = await queue.getJob(jobId);

  if (!job) {
    return {
      jobId,
      state: "unknown",
      attemptsMade: null,
      attemptsAllowed: null,
      enqueuedAt: null,
      dueAt: null,
      startedAt: null,
      finishedAt: null,
      failedReason: null,
    };
  }

  const state = await job.getState();
  const delay = Number(job.opts.delay ?? 0);

  return {
    jobId,
    state: knownState(state),
    attemptsMade: job.attemptsMade,
    attemptsAllowed:
      typeof job.opts.attempts === "number" ? job.opts.attempts : null,
    enqueuedAt: new Date(job.timestamp),
    dueAt: state === "delayed" ? new Date(job.timestamp + delay) : null,
    startedAt: job.processedOn === undefined ? null : new Date(job.processedOn),
    finishedAt: job.finishedOn === undefined ? null : new Date(job.finishedOn),
    failedReason: boundedFailureReason(job.failedReason),
  };
}

/**
 * `getState()` may answer `unknown` for an id that vanished between the fetch
 * and the state read, and a future BullMQ state we do not know about must not
 * be published as if we did.
 */
function knownState(state: string): FeedbackDeliverJobState {
  return (
    FEEDBACK_DELIVER_JOB_STATES.find((candidate) => candidate === state) ??
    "unknown"
  );
}

function boundedFailureReason(reason: unknown): string | null {
  if (typeof reason !== "string") {
    return null;
  }
  const normalized = reason.trim();
  return normalized === "" ? null : normalized.slice(0, 500);
}
