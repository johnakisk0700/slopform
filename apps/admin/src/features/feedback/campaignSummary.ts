import type { FeedbackCampaignSummaryDtoOutput } from "../../api/generated/model/feedbackCampaignSummaryDtoOutput";
import type { FeedbackCampaignSummaryDtoOutputStatus } from "../../api/generated/model/feedbackCampaignSummaryDtoOutputStatus";

/** Collapsed-header status text next to "Campaign summary". */
export function campaignSummaryStatusLabel(
  summary: Pick<FeedbackCampaignSummaryDtoOutput, "status" | "isPartial">,
): string {
  switch (summary.status) {
    case "none":
      return "Not generated";
    case "pending":
      return "Generating…";
    case "failed":
      return "Failed";
    case "ready":
      return summary.isPartial ? "Partial" : "Ready";
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
