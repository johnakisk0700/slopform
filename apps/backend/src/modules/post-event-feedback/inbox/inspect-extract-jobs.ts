import type { Job, Queue } from "bullmq";

import { createFeedbackExtractJobId } from "../jobs.schemas.js";

const PENDING_STATES = new Set([
  "delayed",
  "waiting",
  "waiting-children",
  "prioritized",
]);

/**
 * What the detail endpoint can honestly report about extract jobs still in
 * Redis for one conversation. Absence of a job is deliberately *not* mapped to
 * a confident label: retention, a lost enqueue and "already ran" all look the
 * same once the row is gone.
 *
 * Same shape the simulator already uses for rehearsal status — keep the two
 * readers aligned so a state the operator pane reports is the one a rehearsal
 * run would also see.
 */
export interface FeedbackExtractJobsInspection {
  readonly active: boolean;
  readonly pending: boolean;
  readonly failedReason: string | null;
  readonly nextExtractionAt: Date | null;
  /** True when at least one of the inspected job ids still exists in Redis. */
  readonly jobFound: boolean;
}

/**
 * Inspect BullMQ extract jobs for the given transcript positions.
 *
 * Job ids are `feedback-extract-v1-<conversationId>-<latestSeq>`; pass every
 * participant seq that still sits beyond the extraction cursor (and nothing
 * earlier — those runs either completed or left a retained failure that is no
 * longer the unread window).
 */
export async function inspectFeedbackExtractJobs(
  queue: Pick<Queue, "getJob">,
  conversationId: string,
  participantSeqs: readonly number[],
  /**
   * Extra job ids to inspect alongside the positional ones.
   *
   * A conversation parked on a provider incident carries its next attempt under
   * its own id — the positional job for that seq has already failed — so without
   * this the pane would report a conversation that failed and stopped, when in
   * fact a retry is queued and due. The caller derives them from the document's
   * park counter; nothing here guesses an id.
   */
  extraJobIds: readonly string[] = [],
): Promise<FeedbackExtractJobsInspection> {
  const uniqueSeqs = [...new Set(participantSeqs)].sort((a, b) => a - b);
  if (uniqueSeqs.length === 0 && extraJobIds.length === 0) {
    return {
      active: false,
      pending: false,
      failedReason: null,
      nextExtractionAt: null,
      jobFound: false,
    };
  }

  const jobIds = [
    ...uniqueSeqs.map((seq) => createFeedbackExtractJobId(conversationId, seq)),
    ...extraJobIds,
  ];
  const jobs = await Promise.all(jobIds.map((jobId) => queue.getJob(jobId)));
  const states = await Promise.all(
    jobs.map((job) => (job ? job.getState() : Promise.resolve("unknown"))),
  );

  const active = states.includes("active");
  const pending = states.some((state) => PENDING_STATES.has(state));
  const failedIndex = states.findIndex((state) => state === "failed");
  const failedReason =
    failedIndex === -1
      ? null
      : boundedErrorMessage(
          jobs[failedIndex]?.failedReason,
          "The extraction job failed.",
        );
  const delayedTimes = jobs.flatMap((job, index) => {
    if (!job || states[index] !== "delayed") {
      return [];
    }
    return [dueAt(job)];
  });

  return {
    active,
    pending,
    failedReason,
    nextExtractionAt:
      delayedTimes.length === 0
        ? null
        : delayedTimes.reduce((earliest, candidate) =>
            candidate < earliest ? candidate : earliest,
          ),
    jobFound: jobs.some((job) => job !== undefined && job !== null),
  };
}

/**
 * Participant message seqs the extraction cursor has not yet covered. The
 * unread count the operator pane shows is exactly this list's length.
 */
export function unreadParticipantSeqs(conversation: {
  readonly messages: readonly {
    readonly seq: number;
    readonly actor: string;
  }[];
  readonly extraction: { readonly cursorSeq: number };
}): number[] {
  return conversation.messages
    .filter(
      (message) =>
        message.actor === "participant" &&
        message.seq > conversation.extraction.cursorSeq,
    )
    .map((message) => message.seq);
}

function dueAt(job: Job): Date {
  return new Date(job.timestamp + Number(job.opts.delay ?? 0));
}

function boundedErrorMessage(error: unknown, fallback: string): string {
  const message =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : fallback;
  const normalized = message.trim() || fallback;
  return normalized.slice(0, 500);
}
