import { Rocket, Unplug } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";

import { useListEvents } from "../api/generated/events";
import {
  useLaunchFeedbackCampaign,
  useListFeedbackCampaigns,
} from "../api/generated/feedback-campaigns";
import { ConfirmAction } from "../components/admin/feedback/ConfirmAction";
import { FeedbackBadges } from "../components/admin/feedback/FeedbackBadges";
import { JtsPageHeader } from "../components/ui/JtsPageHeader";
import { formatTimestamp } from "../features/feedback/conversationView";
import { campaignStatusBadge } from "../features/feedback/labels";
import { apiErrorMessage } from "../lib/api";
import { usePageMeta } from "../lib/usePageMeta";

/**
 * The way into a feedback campaign.
 *
 * Campaigns come from `listFeedbackCampaigns` — a read-only staff list with
 * event titles and conversation progress. Launching remains a separate,
 * confirmed write: `launchFeedbackCampaign` also opens conversations and
 * queues intros for newly eligible attendees, so it must never be used merely
 * to look at an inbox.
 */
export function FeedbackCampaignsPage() {
  const navigate = useNavigate();
  const [launchError, setLaunchError] = useState<string | null>(null);

  usePageMeta(
    "Feedback campaigns",
    "Open a post-event feedback campaign's conversation inbox.",
  );

  const campaignsQuery = useListFeedbackCampaigns();
  const eventsQuery = useListEvents();
  const launchCampaign = useLaunchFeedbackCampaign();

  const campaigns = useMemo(
    () => campaignsQuery.data?.items ?? [],
    [campaignsQuery.data?.items],
  );

  const finishedEventsWithoutCampaign = useMemo(() => {
    const withCampaign = new Set(campaigns.map((row) => row.eventId));
    return (eventsQuery.data?.items ?? []).filter(
      (event) => event.status === "finished" && !withCampaign.has(event.id),
    );
  }, [campaigns, eventsQuery.data?.items]);

  async function handleLaunch(eventId: string) {
    setLaunchError(null);
    try {
      const campaign = await launchCampaign.mutateAsync({ data: { eventId } });
      await navigate(`/admin/feedback/${campaign.id}`);
    } catch (cause) {
      setLaunchError(
        apiErrorMessage(cause, "The campaign could not be launched or opened."),
      );
    }
  }

  return (
    <div className="flex flex-col gap-8">
      <JtsPageHeader
        eyebrow="Post-event feedback"
        title="Feedback campaigns"
        description="Each finished event can run one feedback campaign. Open its inbox to read and steer the conversations."
      />

      {launchError ? (
        <p role="alert" className="text-sm text-danger">
          {launchError}
        </p>
      ) : null}

      <section aria-labelledby="campaigns" className="flex flex-col gap-3">
        <h2 id="campaigns" className="jts-overline text-ink-muted">
          Campaigns
        </h2>

        {campaignsQuery.isPending ? (
          <p role="status" className="text-sm text-ink-muted">
            Loading campaigns…
          </p>
        ) : campaignsQuery.isError ? (
          <p role="alert" className="text-sm text-danger">
            {apiErrorMessage(campaignsQuery.error, "Failed to load campaigns.")}
          </p>
        ) : campaigns.length === 0 ? (
          <p className="text-sm text-ink-muted">
            No campaigns yet. Launch one from a finished event below.
          </p>
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {campaigns.map((entry) => {
              const status = campaignStatusBadge(entry.status);
              return (
                <li key={entry.id}>
                  <Link
                    to={`/admin/feedback/${entry.id}`}
                    className="block rounded-md border border-border bg-surface px-4 py-3 no-underline transition-colors hover:border-primary-border"
                  >
                    <span className="flex items-start justify-between gap-2">
                      <span className="block min-w-0 truncate text-sm font-bold text-ink">
                        {entry.eventTitle ?? "Untitled event"}
                      </span>
                      <FeedbackBadges badges={[status]} />
                    </span>
                    <span className="mt-1 block text-xs text-ink-muted">
                      Launched {formatTimestamp(entry.launchedAt)}
                    </span>
                    <span className="mt-0.5 block text-xs text-ink-muted tabular-nums">
                      {entry.openCount} open of {entry.conversationCount}
                      {entry.needsAttentionCount > 0
                        ? ` · ${entry.needsAttentionCount} need attention`
                        : ""}
                    </span>
                    {/* Its own line and its own colour, because it is the one
                        thing on this page nobody can act on by opening the
                        campaign — the model is unreachable and the only cure is
                        waiting or topping up. Rendered only above zero. */}
                    {entry.extractionParkedCount > 0 ? (
                      <span className="mt-0.5 flex items-center gap-1.5 text-xs font-semibold text-info tabular-nums">
                        <Unplug
                          aria-hidden="true"
                          className="size-3.5 shrink-0"
                        />
                        {entry.extractionParkedCount} waiting on the model
                      </span>
                    ) : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section
        aria-labelledby="finished-events"
        className="flex flex-col gap-3"
      >
        <h2 id="finished-events" className="jts-overline text-ink-muted">
          Finished events without a campaign
        </h2>

        {eventsQuery.isPending ? (
          <p role="status" className="text-sm text-ink-muted">
            Loading events…
          </p>
        ) : eventsQuery.isError ? (
          <p role="alert" className="text-sm text-danger">
            {apiErrorMessage(eventsQuery.error, "Failed to load events.")}
          </p>
        ) : finishedEventsWithoutCampaign.length === 0 ? (
          <p className="text-sm text-ink-muted">
            Every finished event already has a campaign, or none are finished
            yet. Mark an event finished on{" "}
            <Link to="/admin/events" className="font-semibold text-primary">
              the events screen
            </Link>{" "}
            before launching.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {finishedEventsWithoutCampaign.map((event) => (
              <li
                key={event.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-surface px-4 py-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-bold text-ink">
                    {event.title}
                  </p>
                  <p className="text-xs text-ink-muted tabular-nums">
                    {event.presentCount} present of {event.attendeeCount}{" "}
                    attendees
                  </p>
                </div>
                <ConfirmAction
                  label="Launch campaign"
                  icon={<Rocket aria-hidden="true" className="size-4" />}
                  heading={`Feedback campaign for ${event.title}`}
                  description={
                    <>
                      Creates this event&rsquo;s feedback campaign and queues a
                      conversation plus an intro message for every attendee who
                      is marked present, opted in and has a phone number.
                      Existing conversations are never duplicated or reopened.
                    </>
                  }
                  confirmLabel="Launch"
                  isPending={launchCampaign.isPending}
                  isDisabled={launchCampaign.isPending}
                  onConfirm={() => handleLaunch(event.id)}
                />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
