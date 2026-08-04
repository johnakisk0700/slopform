import type { FeedbackCampaignSummaryDtoOutput } from "../../api/generated/model/feedbackCampaignSummaryDtoOutput";
import type { FeedbackCampaignSummaryDtoOutputStatus } from "../../api/generated/model/feedbackCampaignSummaryDtoOutputStatus";

/**
 * What a `pending` summary is actually doing.
 *
 * `pending` is durable intent, not activity: the row says a summary is owed,
 * never that one is being produced right now. A worker that dies mid-call
 * leaves the row exactly as it found it, so the three states below are the
 * operator's only way to tell a live model call from a queue waiting on
 * backoff — and «Generating…» for both is the reason a fifteen-minute stall
 * used to look like a five-second one.
 */
export type CampaignSummaryPendingPhase = "queued" | "generating" | "retrying";

type PendingSummary = Pick<
  FeedbackCampaignSummaryDtoOutput,
  "status" | "executionEpoch" | "claimExpiresAt"
>;

type StatusSummary = PendingSummary &
  Pick<FeedbackCampaignSummaryDtoOutput, "isPartial" | "requestedAt">;

/**
 * Reads the execution lease behind a pending row. Null for every other status,
 * where no execution is owed and the lease fields are always cleared.
 *
 * A lease horizon still ahead of `now` means a worker holds the claim and is
 * inside the model call. Otherwise nobody is generating: the first execution is
 * still queued, or an earlier one stopped without settling and BullMQ is
 * holding the retry.
 */
export function campaignSummaryPendingPhase(
  summary: PendingSummary,
  now: Date = new Date(),
): CampaignSummaryPendingPhase | null {
  if (summary.status !== "pending") {
    return null;
  }
  const claimExpiresAt = summary.claimExpiresAt
    ? Date.parse(summary.claimExpiresAt)
    : Number.NaN;
  if (!Number.isNaN(claimExpiresAt) && claimExpiresAt > now.getTime()) {
    return "generating";
  }
  return (summary.executionEpoch ?? 0) > 0 ? "retrying" : "queued";
}

/**
 * How long the row has been owed, counted from the request rather than from the
 * current execution: an operator asking "should I worry" means the whole wait,
 * including the runs that died.
 */
export function campaignSummaryElapsedLabel(
  requestedAt: string | null,
  now: Date = new Date(),
): string | null {
  if (!requestedAt) {
    return null;
  }
  const since = Date.parse(requestedAt);
  if (Number.isNaN(since)) {
    return null;
  }
  const seconds = Math.max(0, Math.floor((now.getTime() - since) / 1_000));
  if (seconds < 60) {
    return `${seconds} s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes} min`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/** Collapsed-header status text next to "Campaign summary". */
export function campaignSummaryStatusLabel(
  summary: StatusSummary,
  now: Date = new Date(),
): string {
  switch (summary.status) {
    case "none":
      return "Not generated";
    case "pending":
      return pendingStatusLabel(summary, now);
    case "failed":
      return "Failed";
    case "ready":
      return summary.isPartial ? "Partial" : "Ready";
  }
}

function pendingStatusLabel(summary: StatusSummary, now: Date): string {
  const phase = campaignSummaryPendingPhase(summary, now);
  const elapsed = campaignSummaryElapsedLabel(summary.requestedAt, now);
  const suffix = elapsed ? ` (${elapsed})` : "";
  if (phase === "generating") {
    return `Generating…${suffix}`;
  }
  if (phase === "retrying") {
    // The epoch counts executions already started, so the run BullMQ is holding
    // is the next one. Naming it keeps a repeated stall visible as it climbs.
    return `Waiting to retry — attempt ${(summary.executionEpoch ?? 0) + 1}${suffix}`;
  }
  return `Queued${suffix}`;
}

/**
 * The sentence shown in place of a body while a summary is owed. It says which
 * side is holding the work, because that decides whether the operator waits or
 * goes looking at the workers.
 */
export function campaignSummaryPendingDetail(
  phase: CampaignSummaryPendingPhase,
): string {
  switch (phase) {
    case "queued":
      return "Queued for generation. A worker picks it up as soon as one is free.";
    case "generating":
      return "Generating the summary…";
    case "retrying":
      return "The last run stopped before it finished. The summary is still owed — the queued retry starts once its backoff elapses.";
  }
}

/**
 * The request button's label: first generation (or retry after failure) vs
 * regenerating a summary that already exists or is in flight.
 */
export function campaignSummaryActionLabel(
  status: FeedbackCampaignSummaryDtoOutputStatus,
): "Generate" | "Refresh" {
  return status === "none" || status === "failed" ? "Generate" : "Refresh";
}

/**
 * Warning shown when the summary was built while conversations were still open.
 * Null when the summary is complete.
 */
export function campaignSummaryPartialWarning(
  summary: Pick<
    FeedbackCampaignSummaryDtoOutput,
    "isPartial" | "openConversationCount"
  >,
): string | null {
  if (!summary.isPartial) {
    return null;
  }
  const open = summary.openConversationCount;
  if (open === null) {
    return "Based on incomplete data — some conversations were still open.";
  }
  if (open === 1) {
    return "Based on incomplete data — 1 conversation was still open.";
  }
  return `Based on incomplete data — ${open} conversations were still open.`;
}
