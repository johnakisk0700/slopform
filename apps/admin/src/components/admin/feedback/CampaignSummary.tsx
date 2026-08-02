import { Button, toast } from "@heroui/react";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

import {
  getGetFeedbackCampaignSummaryQueryKey,
  useGetFeedbackCampaignSummary,
  useRequestFeedbackCampaignSummary,
} from "../../../api/generated/feedback-campaigns";
import type { FeedbackCampaignSummaryDtoOutput } from "../../../api/generated/model/feedbackCampaignSummaryDtoOutput";
import {
  campaignSummaryActionLabel,
  campaignSummaryPartialWarning,
  campaignSummaryStatusLabel,
} from "../../../features/feedback/campaignSummary";
import { formatExactTimestamp } from "../../../features/feedback/conversationView";
import { CAMPAIGN_SUMMARY_POLL_INTERVAL_MS } from "../../../features/feedback/polling";
import { apiErrorMessage } from "../../../lib/api";

interface CampaignSummaryProps {
  campaignId: string;
}

function statusToneClass(
  summary: Pick<FeedbackCampaignSummaryDtoOutput, "status" | "isPartial">,
): string {
  if (summary.status === "failed") {
    return "text-danger";
  }
  if (summary.status === "pending") {
    return "text-info";
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

  const statusLabel = summary
    ? campaignSummaryStatusLabel(summary)
    : summaryQuery.isPending
      ? "Loading…"
      : "Not generated";
  const statusClass = summary ? statusToneClass(summary) : "text-ink-muted";
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
          Campaign summary
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
          <div className="space-y-2 text-sm text-ink [&_h1]:text-base [&_h1]:font-semibold [&_h2]:text-sm [&_h2]:font-semibold [&_h3]:text-sm [&_h3]:font-semibold [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:leading-relaxed">
            <Markdown remarkPlugins={[remarkGfm]}>{summary.body}</Markdown>
          </div>
        ) : null}

        {!summary?.body && summary?.status === "none" ? (
          <p className="text-sm text-ink-muted">
            No summary yet. Generate one from the answers and notes collected so
            far.
          </p>
        ) : null}

        {!summary?.body && generating ? (
          <p className="text-sm text-ink-muted">Generating the summary…</p>
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
