import {
  AlertTriangle,
  CircleCheck,
  type LucideIcon,
  MessageCircleWarning,
  Pause,
  SendHorizontal,
} from "lucide-react";
import { type ReactNode } from "react";

import type { OverviewDtoOutput } from "../../api/generated/model/overviewDtoOutput";
import { attentionReasonLabel } from "../../features/feedback/labels";

/** One row in the "Needs attention" operator queue. */
export interface QueueItem {
  key: string;
  icon: LucideIcon;
  title: string;
  subtitle: string;
  stampTone: StampTone;
  stampLabel: ReactNode;
  to: string;
}

export function buildAttentionQueue(data: OverviewDtoOutput): QueueItem[] {
  const items: QueueItem[] = data.feedback.conversations.attentionByReason.map(
    (entry) => ({
      key: `reason-${entry.reason}`,
      icon: MessageCircleWarning,
      title: attentionReasonLabel(entry.reason).replace(/\.$/u, ""),
      subtitle: "Unresolved across open campaigns",
      stampTone: entry.reason === "safety" ? "danger" : "warning",
      stampLabel: entry.count,
      to: "/admin/feedback",
    }),
  );

  if (data.feedback.conversations.extractionParked > 0) {
    items.push({
      key: "extraction-parked",
      icon: Pause,
      title: "Extraction parked",
      subtitle: "Provider or deployment trouble, not a person request",
      stampTone: "warning",
      stampLabel: data.feedback.conversations.extractionParked,
      to: "/admin/feedback",
    });
  }

  if (data.feedback.outbox.ambiguous > 0 || data.feedback.outbox.held > 0) {
    items.push({
      key: "outbox-stuck",
      icon: SendHorizontal,
      title: "Outbound needs a look",
      subtitle: "Ambiguous or deliberately held deliveries",
      stampTone: "danger",
      stampLabel: data.feedback.outbox.ambiguous + data.feedback.outbox.held,
      to: "/admin/outbound",
    });
  }

  if (data.feedback.summaries.failed > 0) {
    items.push({
      key: "summaries-failed",
      icon: AlertTriangle,
      title: "Campaign summaries failed",
      subtitle: "Retry from the campaign results screen",
      stampTone: "warning",
      stampLabel: data.feedback.summaries.failed,
      to: "/admin/feedback",
    });
  }

  if (data.events.finishedWithoutFeedbackCampaignCount > 0) {
    items.push({
      key: "finished-no-campaign",
      icon: CircleCheck,
      title: "Finished dinners without feedback",
      subtitle: "Mark finished is the gate — launching is still the next step",
      stampTone: "info",
      stampLabel: data.events.finishedWithoutFeedbackCampaignCount,
      to: "/admin/feedback",
    });
  }

  return items;
}

/** Ledger-stamp tones — the status hues sanctioned by the design contract. */
export type StampTone = "primary" | "success" | "warning" | "danger" | "info";

export const stampToneText: Record<StampTone, string> = {
  primary: "text-primary",
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
  info: "text-info",
};

const dateTimeFormatter = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

const dateFormatter = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

export function formatDateTime(value: string): string {
  return dateTimeFormatter.format(new Date(value));
}

export function formatDate(value: string): string {
  return dateFormatter.format(new Date(value));
}
