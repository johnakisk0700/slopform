import {
  BarChart3,
  ChevronLeft,
  FlaskConical,
  PauseCircle,
  PlayCircle,
  SquareX,
  TriangleAlert,
  Unplug,
} from "lucide-react";
import { Link } from "react-router";

import type { FeedbackCampaignConversationsDtoOutputCampaign } from "../../../api/generated/model/feedbackCampaignConversationsDtoOutputCampaign";
import { campaignStatusBadge } from "../../../features/feedback/labels";
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
    /* Two rows, not four. This header used to stack the back link, an eyebrow,
       the title, an actions row and the campaign line — ~230px before the
       first message of the transcript this screen exists for. The eyebrow is
       gone (the sidebar item and the back link already place the page), the
       actions share the back link's line, and the campaign line sits beside
       the title. */
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        {/* A back affordance, not a peer of the campaign's own actions: it
            leaves this campaign rather than doing something to it. Same glyph
            and classes as the profile page's back link — one admin, one
            pattern. */}
        <Link
          to="/admin/feedback"
          className="inline-flex items-center gap-1.5 text-sm font-semibold text-primary"
        >
          <ChevronLeft aria-hidden="true" className="size-4 shrink-0" />
          All campaigns
        </Link>

        <div className="flex flex-wrap items-center gap-3">
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
        </div>
      </div>

      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
        {/* The route's single h1, with the signature marker — the same
            treatment `JtsPageHeader` gives it, without that component's
            stacked eyebrow/description/actions rows this working surface
            cannot afford. */}
        <h1 className="font-display text-[1.375rem] font-extrabold after:mt-1.5 after:block after:h-[3px] after:w-8 after:bg-primary after:content-['']">
          {campaign?.eventTitle ?? "Feedback conversations"}
        </h1>

        {/* Exceptions only, and nothing when nothing is wrong. The counts that
            used to live here («N conversations · N open») restated what the
            list's own headings count right beside them, and the «Launched»
            pill badged the normal state of every working campaign. What is
            left appears exactly when it is news: a paused or closed campaign,
            conversations waiting for a person, extraction parked on a dead
            provider, a simulated transport. A launched campaign with nothing
            waiting states itself with silence. */}
        {campaign ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 pb-0.5 text-sm text-ink-muted">
            {campaign.status !== "launched" ? (
              <FeedbackBadges badges={[campaignStatusBadge(campaign.status)]} />
            ) : null}
            {campaign.needsAttentionCount > 0 ? (
              <p className="flex items-center gap-1.5 font-semibold text-warning">
                <TriangleAlert aria-hidden="true" className="size-4 shrink-0" />
                <span className="tabular-nums">
                  {campaign.needsAttentionCount}
                </span>
                need attention
              </p>
            ) : null}
            {/* Beside the triangle and deliberately not inside it. «Needs
                attention» means these conversations want a person; a parked one
                wants a working provider, and no operator can do anything for it
                but wait. Rolling the two together is how one outage became
                thirty-six things to read on 2026-07-27.

                Its own glyph for the same reason: an unplugged cable says «the
                model is unreachable» in a way a second warning triangle would
                not. It renders only above zero, so the ordinary campaign line is
                unchanged and this appears exactly when there is an incident. */}
            {campaign.extractionParkedCount > 0 ? (
              <p className="flex items-center gap-1.5 font-semibold text-info">
                <Unplug aria-hidden="true" className="size-4 shrink-0" />
                <span className="tabular-nums">
                  {campaign.extractionParkedCount}
                </span>
                waiting on the model
              </p>
            ) : null}
            {/* Muted, not warning: it is a fact about the environment, present
                on every dev screen, and a permanent amber line stops being
                read the day it appears. */}
            {simulatorAvailable ? (
              <p className="flex items-center gap-1.5 jts-overline text-ink-muted">
                <FlaskConical
                  aria-hidden="true"
                  className="size-3.5 shrink-0"
                />
                Simulated transport
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
