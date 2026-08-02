import {
  BarChart3,
  FlaskConical,
  PauseCircle,
  PlayCircle,
  SquareX,
  TriangleAlert,
  Unplug,
} from "lucide-react";
import { Link } from "react-router";

import type { FeedbackCampaignConversationsDtoOutputCampaign } from "../../../api/generated/model/feedbackCampaignConversationsDtoOutputCampaign";
import type { EventVenueValue } from "../../../features/event/venue";
import { campaignStatusBadge } from "../../../features/feedback/labels";
import { JtsBackLink } from "../../ui/JtsBackLink";
import { VenueCompact } from "../events/VenueDisplay";
import { ConfirmAction } from "./ConfirmAction";
import { FeedbackBadges } from "./FeedbackBadges";

interface CampaignHeaderProps {
  campaign: FeedbackCampaignConversationsDtoOutputCampaign | undefined;
  pausePending: boolean;
  resumePending: boolean;
  closePending: boolean;
  onPause: () => Promise<void>;
  onResume: () => Promise<void>;
  onClose: () => Promise<void>;
}

export function CampaignHeader({
  campaign,
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
       gone (the sidebar item and the back link already place the page) and the
       actions share the back link's line.

       What is left is the page saying what page it is: the way out, what you
       can do to this campaign, and its name. The venue and the exceptions moved
       to `CampaignContext` below, because they answer «what is true about this
       campaign right now» — a question the summary card underneath also
       answers, and the title does not. */
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        {/* A back affordance, not a peer of the campaign's own actions: it
            leaves this campaign rather than doing something to it. The shared
            JtsBackLink, so this screen's exit is the one every other screen
            has — the compact header only decides that it shares the actions'
            line instead of standing on its own. */}
        <JtsBackLink to="/admin/feedback">Back to campaigns</JtsBackLink>

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

      <h1 className="jts-title-mark font-display text-[1.375rem] font-extrabold">
        {campaign?.eventTitle ?? "Feedback conversations"}
      </h1>
    </div>
  );
}

interface CampaignContextProps {
  campaign: FeedbackCampaignConversationsDtoOutputCampaign | undefined;
  venue: EventVenueValue | null;
  simulatorAvailable: boolean;
}

/**
 * One line of standing context, between the title and the summary card.
 *
 * It used to hang off the title: the venue in a sunken box 8px under the six-dot
 * mark, the exceptions floating bottom-aligned beside it. That glued two facts
 * about the *campaign* onto the page's own nameplate, and put a second bordered
 * block directly under the mark where the eye is still reading the heading.
 *
 * Here it is a bare row — where the dinner was at one end, what is wrong at the
 * other — sitting one small gap above `CampaignSummary`, which answers the same
 * kind of question. The summary keeps the only frame on this band; a second
 * border around the venue would make two cards out of one thought.
 *
 * Nothing at all when there is no venue and no exception: a launched campaign
 * with everything running states itself with silence, and the transcript gets
 * the row back.
 */
export function CampaignContext({
  campaign,
  venue,
  simulatorAvailable,
}: CampaignContextProps) {
  const hasException =
    campaign !== undefined &&
    (campaign.status !== "launched" ||
      campaign.needsAttentionCount > 0 ||
      campaign.extractionParkedCount > 0 ||
      simulatorAvailable);

  if (!venue && !hasException) {
    return null;
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
      {venue ? (
        <section aria-label="Dinner venue" className="min-w-0">
          <VenueCompact venue={venue} />
        </section>
      ) : (
        /* Holds the left end so a lone exception stays on the right, where it
           is in every other state of this screen. */
        <span aria-hidden="true" />
      )}

      {/* Exceptions only, and nothing when nothing is wrong. The counts that
          used to live here («N conversations · N open») restated what the
          list's own headings count right beside them, and the «Launched» pill
          badged the normal state of every working campaign. What is left
          appears exactly when it is news: a paused or closed campaign,
          conversations waiting for a person, extraction parked on a dead
          provider, a simulated transport. */}
      {hasException ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-ink-muted">
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
              on every dev screen, and a permanent amber line stops being read
              the day it appears. */}
          {simulatorAvailable ? (
            <p className="flex items-center gap-1.5 jts-overline text-ink-muted">
              <FlaskConical aria-hidden="true" className="size-3.5 shrink-0" />
              Simulated transport
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
