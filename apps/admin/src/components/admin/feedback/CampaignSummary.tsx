import { Button, toast } from "@heroui/react";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";

import { AssistantMarkdown } from "../assistant/AssistantMarkdown";
import {
  getGetFeedbackCampaignSummaryQueryKey,
  useGetFeedbackCampaignSummary,
  useRequestFeedbackCampaignSummary,
} from "../../../api/generated/feedback-campaigns";
import type { FeedbackCampaignSummaryDtoOutput } from "../../../api/generated/model/feedbackCampaignSummaryDtoOutput";
import {
  campaignSummaryActionLabel,
  campaignSummaryPartialWarning,
  campaignSummaryPendingDetail,
  campaignSummaryPendingPhase,
  campaignSummaryStatusLabel,
  type CampaignSummaryPendingPhase,
} from "../../../features/feedback/campaignSummary";
import { formatExactTimestamp } from "../../../features/feedback/conversationView";
import { CAMPAIGN_SUMMARY_POLL_INTERVAL_MS } from "../../../features/feedback/polling";
import { apiErrorMessage } from "../../../lib/api";

interface CampaignSummaryProps {
  campaignId: string;
}

function statusToneClass(
  summary: Pick<FeedbackCampaignSummaryDtoOutput, "status" | "isPartial">,
  phase: CampaignSummaryPendingPhase | null,
): string {
  if (summary.status === "failed") {
    return "text-danger";
  }
  if (summary.status === "pending") {
    // A lapsed claim is not a failure — the row still self-heals — but it is
    // the state worth a second look, so it does not share the calm live tone.
    return phase === "retrying" ? "text-warning" : "text-info";
  }
  if (summary.status === "ready" && summary.isPartial) {
    return "text-warning";
  }
  if (summary.status === "ready") {
    return "text-success";
  }
  return "text-ink-muted";
}

function countLabel(count: number, singular: string, plural: string): string {
  return count === 1 ? `1 ${singular}` : `${count} ${plural}`;
}

function metaParts(summary: FeedbackCampaignSummaryDtoOutput): string[] {
  const parts: string[] = [];
  if (summary.answerCount !== null) {
    parts.push(countLabel(summary.answerCount, "answer", "answers"));
  }
  if (summary.noteCount !== null) {
    parts.push(countLabel(summary.noteCount, "note", "notes"));
  }
  // The header carries how long the wait has been; a row that is still owed
  // also gets the exact clock it started from, which is what a worker log or an
  // audit entry is read against.
  if (summary.status === "pending" && summary.requestedAt !== null) {
    parts.push(`Requested ${formatExactTimestamp(summary.requestedAt)}`);
  }
  if (summary.generatedAt !== null) {
    parts.push(`Generated ${formatExactTimestamp(summary.generatedAt)}`);
  }
  return parts;
}

/**
 * Collapsible AI narrative for the open campaign: status in the header, body
 * and regenerate control when expanded. Polls only while generation is pending.
 */
export function CampaignSummary({ campaignId }: CampaignSummaryProps) {
  const queryClient = useQueryClient();

  const summaryQuery = useGetFeedbackCampaignSummary(campaignId, {
    query: {
      enabled: campaignId !== "",
      refetchInterval: (query) =>
        query.state.data?.status === "pending"
          ? CAMPAIGN_SUMMARY_POLL_INTERVAL_MS
          : false,
    },
  });

  const requestSummary = useRequestFeedbackCampaignSummary();
  const summary = summaryQuery.data;

  // Elapsed time is read as of the last successful fetch rather than of the
  // render. Reading `dataUpdatedAt` is also what keeps it moving: structural
  // sharing hands back an identical `data` on an unchanged poll, so a render
  // clock would both sit frozen on the stalled row this label exists to expose
  // and be impure here. It is only ever read alongside `data`, which is what
  // stamped it.
  const asOf = new Date(summaryQuery.dataUpdatedAt);
  const pendingPhase = summary
    ? campaignSummaryPendingPhase(summary, asOf)
    : null;

  const statusLabel = summary
    ? campaignSummaryStatusLabel(summary, asOf)
    : summaryQuery.isPending
      ? "Loading…"
      : "Not generated";
  const statusClass = summary
    ? statusToneClass(summary, pendingPhase)
    : "text-ink-muted";
  const actionLabel = campaignSummaryActionLabel(summary?.status ?? "none");
  const partialWarning = summary
    ? campaignSummaryPartialWarning(summary)
    : null;
  const meta = summary ? metaParts(summary) : [];
  const generating = summary?.status === "pending";
  const requestPending = requestSummary.isPending;

  async function handleRequest() {
    try {
      await requestSummary.mutateAsync({ campaignId });
      await queryClient.invalidateQueries({
        queryKey: getGetFeedbackCampaignSummaryQueryKey(campaignId),
      });
    } catch (cause) {
      toast(apiErrorMessage(cause, "The summary could not be requested."), {
        variant: "danger",
      });
    }
  }

  return (
    <details className="jts-disclosure group rounded-lg border border-border bg-surface">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-semibold text-ink marker:content-none [&::-webkit-details-marker]:hidden">
        <span className="flex min-w-0 items-center gap-2">
          <ChevronDown
            aria-hidden="true"
            className="size-4 shrink-0 text-ink-muted transition-transform duration-200 group-open:rotate-180"
          />
          <span className="truncate">Campaign summary</span>
        </span>
        <span className={`shrink-0 font-medium ${statusClass}`}>
          {statusLabel}
        </span>
      </summary>

      <div className="grid gap-3 border-t border-border px-4 py-3">
        {summaryQuery.isError ? (
          <p role="alert" className="text-sm text-danger">
            {apiErrorMessage(
              summaryQuery.error,
              "Failed to load the campaign summary.",
            )}
          </p>
        ) : null}

        {summary?.status === "failed" && summary.error ? (
          <p role="alert" className="text-sm text-danger">
            {summary.error}
          </p>
        ) : null}

        {summary?.body ? (
          /*
           * The same renderer the assistant uses, because this is the same kind
           * of thing: a body a model wrote for an operator to read. That is what
           * buys the summary tables, quotations and fenced `chart` blocks
           * without a second markdown pipeline to keep in step with the first.
           */
          <div className="assistant-markdown max-w-none">
            <AssistantMarkdown>{summary.body}</AssistantMarkdown>
          </div>
        ) : null}

        {!summary?.body && summary?.status === "none" ? (
          <p className="text-sm text-ink-muted">
            No summary yet. Generate one from the answers and notes collected so
            far.
          </p>
        ) : null}

        {!summary?.body && pendingPhase ? (
          <p className="text-sm text-ink-muted">
            {campaignSummaryPendingDetail(pendingPhase)}
          </p>
        ) : null}

        {meta.length > 0 || partialWarning ? (
          <div className="grid gap-1 text-xs text-ink-muted">
            {meta.length > 0 ? <p>{meta.join(" · ")}</p> : null}
            {partialWarning ? (
              <p className="font-medium text-warning">{partialWarning}</p>
            ) : null}
          </div>
        ) : null}

        <div>
          <Button
            size="sm"
            variant="secondary"
            isPending={requestPending}
            isDisabled={generating || requestPending || campaignId === ""}
            onPress={() => {
              void handleRequest();
            }}
          >
            {actionLabel}
          </Button>
        </div>
      </div>
    </details>
  );
}
