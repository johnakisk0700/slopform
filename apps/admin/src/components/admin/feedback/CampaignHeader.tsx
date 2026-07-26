import type { LucideIcon } from "lucide-react";
import {
  BarChart3,
  ChevronLeft,
  FlaskConical,
  MessageCircleMore,
  MessagesSquare,
  PauseCircle,
  PlayCircle,
  SquareX,
  TriangleAlert,
} from "lucide-react";
import { Link } from "react-router";

import type { FeedbackCampaignConversationsDtoOutputCampaign } from "../../../api/generated/model/feedbackCampaignConversationsDtoOutputCampaign";
import { campaignStatusBadge } from "../../../features/feedback/labels";
import { JtsPageHeader } from "../../ui/JtsPageHeader";
import { ConfirmAction } from "./ConfirmAction";
import { FeedbackBadges } from "./FeedbackBadges";

interface CampaignHeaderProps {
  campaign: FeedbackCampaignConversationsDtoOutputCampaign | undefined;
  simulatorAvailable: boolean;
  pausePending: boolean;
  resumePending: boolean;
  closePending: boolean;
  onPause: () => Promise<void>;
  onResume: () => Promise<void>;
  onClose: () => Promise<void>;
}

/** One campaign tally: a muted stroke icon, the number, then what it counts. */
function CampaignCount({
  icon: Icon,
  value,
  children,
}: {
  icon: LucideIcon;
  value: number;
  children: string;
}) {
  return (
    <p className="flex items-center gap-1.5 text-sm text-ink-muted">
      <Icon aria-hidden="true" className="size-4 shrink-0 text-ink-subtle" />
      <strong className="font-bold text-ink tabular-nums">{value}</strong>
      {children}
    </p>
  );
}

export function CampaignHeader({
  campaign,
  simulatorAvailable,
  pausePending,
  resumePending,
  closePending,
  onPause,
  onResume,
  onClose,
}: CampaignHeaderProps) {
  const campaignBusy = pausePending || resumePending || closePending;

  return (
    <>
      {/* A back affordance, not a peer of the campaign's own actions: it leaves
          this campaign rather than doing something to it. Same glyph and
          classes as the profile page's back link — one admin, one pattern. */}
      <Link
        to="/admin/feedback"
        className="inline-flex items-center gap-1.5 self-start text-sm font-semibold text-primary"
      >
        <ChevronLeft aria-hidden="true" className="size-4 shrink-0" />
        All campaigns
      </Link>

      <JtsPageHeader
        eyebrow="Post-event feedback"
        title={campaign?.eventTitle ?? "Feedback conversations"}
        description="Read every conversation for this campaign, take one over when it needs a person, and hand it back when it does not."
        actions={
          <>
            {campaign ? (
              <Link
                to={`/admin/feedback/${campaign.id}/results`}
                className="inline-flex items-center gap-1.5 self-center text-sm font-semibold text-primary"
              >
                <BarChart3 aria-hidden="true" className="size-4 shrink-0" />
                Results
              </Link>
            ) : null}

            {/* Reading the campaign's output and changing its state are two
                different kinds of act; a hairline says so without a heading. */}
            {campaign && campaign.status !== "closed" ? (
              <span
                aria-hidden="true"
                className="hidden h-6 self-center border-l border-border sm:block"
              />
            ) : null}

            {campaign?.status === "launched" ? (
              <ConfirmAction
                label="Pause campaign"
                icon={<PauseCircle aria-hidden="true" className="size-4" />}
                heading="Pause this campaign"
                description="Queued messages stop going out until you resume. Conversations already open stay open, and replies still arrive."
                confirmLabel="Pause campaign"
                isPending={pausePending}
                isDisabled={campaignBusy}
                onConfirm={onPause}
              />
            ) : null}

            {campaign?.status === "paused" ? (
              <ConfirmAction
                label="Resume campaign"
                icon={<PlayCircle aria-hidden="true" className="size-4" />}
                heading="Resume this campaign"
                description="Queued messages start going out again, including anything held while the campaign was paused."
                confirmLabel="Resume campaign"
                isPending={resumePending}
                isDisabled={campaignBusy}
                onConfirm={onResume}
              />
            ) : null}

            {campaign && campaign.status !== "closed" ? (
              <ConfirmAction
                label="Close campaign"
                tone="danger"
                icon={<SquareX aria-hidden="true" className="size-4" />}
                heading="Close this campaign"
                description="The kill switch: nothing further is sent and everything still queued is cancelled. Open conversations are left to STOP, expiry or a staff close. This cannot be undone."
                confirmLabel="Close campaign"
                isPending={closePending}
                isDisabled={campaignBusy}
                onConfirm={onClose}
              />
            ) : null}
          </>
        }
      />

      {campaign ? (
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-md border border-border bg-surface px-4 py-3">
          <FeedbackBadges badges={[campaignStatusBadge(campaign.status)]} />
          <CampaignCount
            icon={MessagesSquare}
            value={campaign.conversationCount}
          >
            conversations
          </CampaignCount>
          <CampaignCount icon={MessageCircleMore} value={campaign.openCount}>
            open
          </CampaignCount>
          <CampaignCount
            icon={TriangleAlert}
            value={campaign.needsAttentionCount}
          >
            need attention
          </CampaignCount>
          {simulatorAvailable ? (
            <p className="flex items-center gap-1.5 jts-overline text-warning">
              <FlaskConical aria-hidden="true" className="size-3.5 shrink-0" />
              Simulated transport
            </p>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
