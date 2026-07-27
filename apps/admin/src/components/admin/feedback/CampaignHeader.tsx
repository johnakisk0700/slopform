import {
  BarChart3,
  ChevronLeft,
  FlaskConical,
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

/** One campaign tally: the number, then what it counts. */
function CampaignCount({
  value,
  children,
}: {
  value: number;
  children: string;
}) {
  return (
    <span>
      <strong className="font-bold text-ink tabular-nums">{value}</strong>{" "}
      {children}
    </span>
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

      {/* One quiet line, not a bordered summary bar: the list beside it already
          groups and counts the same conversations, so this only has to say
          which campaign state they sit in. The triangle appears only when
          something is actually waiting — the same glyph the list's NEEDS
          ATTENTION heading uses. */}
      {campaign ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-ink-muted">
          <FeedbackBadges badges={[campaignStatusBadge(campaign.status)]} />
          <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
            <CampaignCount value={campaign.conversationCount}>
              conversations
            </CampaignCount>
            <span aria-hidden="true" className="text-ink-subtle">
              ·
            </span>
            <CampaignCount value={campaign.openCount}>open</CampaignCount>
            {campaign.needsAttentionCount > 0 ? (
              <>
                <span aria-hidden="true" className="text-ink-subtle">
                  ·
                </span>
                <span className="flex items-center gap-1.5 font-semibold text-warning">
                  <TriangleAlert
                    aria-hidden="true"
                    className="size-4 shrink-0"
                  />
                  <span className="tabular-nums">
                    {campaign.needsAttentionCount}
                  </span>
                  need attention
                </span>
              </>
            ) : null}
          </p>
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
