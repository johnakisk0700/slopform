import { Rocket } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";

import { useListEvents } from "../api/generated/events";
import { useLaunchFeedbackCampaign } from "../api/generated/feedback-campaigns";
import { ConfirmAction } from "../components/admin/feedback/ConfirmAction";
import { JtsPageHeader } from "../components/ui/JtsPageHeader";
import { formatTimestamp } from "../features/feedback/conversationView";
import {
  readRecentCampaigns,
  rememberRecentCampaign,
} from "../features/feedback/recentCampaigns";
import { usePageMeta } from "../lib/usePageMeta";

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message !== ""
    ? cause.message
    : fallback;
}

/**
 * The way into a feedback campaign.
 *
 * The backend publishes no "list campaigns" operation and no campaign id on
 * the event read model, so the only server-side way to turn an event into a
 * campaign id is `launchFeedbackCampaign` — which also opens conversations and
 * queues intros for newly eligible attendees. That makes it a deliberate
 * action, never a page load, so this screen separates the two: campaigns this
 * browser has already opened are plain links, and launching is an explicit
 * confirmed step that says what it will send.
 */
export function FeedbackCampaignsPage() {
  const navigate = useNavigate();
  const [launchError, setLaunchError] = useState<string | null>(null);

  usePageMeta(
    "Feedback campaigns",
    "Open a post-event feedback campaign's conversation inbox.",
  );

  const eventsQuery = useListEvents();
  const launchCampaign = useLaunchFeedbackCampaign();

  // Read once per mount: this is a local shortcut list, not live state.
  const recent = useMemo(() => readRecentCampaigns(), []);

  const finishedEvents = useMemo(
    () =>
      (eventsQuery.data?.items ?? []).filter(
        (event) => event.status === "finished",
      ),
    [eventsQuery.data?.items],
  );

  async function handleLaunch(eventId: string, eventTitle: string) {
    setLaunchError(null);
    try {
      const campaign = await launchCampaign.mutateAsync({ data: { eventId } });
      rememberRecentCampaign({
        campaignId: campaign.id,
        eventId: campaign.eventId,
        eventTitle,
        openedAt: new Date().toISOString(),
      });
      await navigate(`/admin/feedback/${campaign.id}`);
    } catch (cause) {
      setLaunchError(
        errorMessage(cause, "The campaign could not be launched or opened."),
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

      <section
        aria-labelledby="recent-campaigns"
        className="flex flex-col gap-3"
      >
        <h2
          id="recent-campaigns"
          className="text-[0.7rem] font-extrabold uppercase tracking-caps text-ink-muted"
        >
          Recently opened on this device
        </h2>
        {recent.length === 0 ? (
          <p className="text-sm text-ink-muted">
            Nothing yet. Launch or open a campaign below and it will appear here
            for quick access.
          </p>
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {recent.map((entry) => (
              <li key={entry.campaignId}>
                <Link
                  to={`/admin/feedback/${entry.campaignId}`}
                  className="block rounded-md border border-border bg-surface px-4 py-3 no-underline transition-colors hover:border-primary-border"
                >
                  <span className="block truncate text-sm font-bold text-ink">
                    {entry.eventTitle}
                  </span>
                  <span className="mt-0.5 block text-xs text-ink-muted">
                    Opened {formatTimestamp(entry.openedAt)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section
        aria-labelledby="finished-events"
        className="flex flex-col gap-3"
      >
        <h2
          id="finished-events"
          className="text-[0.7rem] font-extrabold uppercase tracking-caps text-ink-muted"
        >
          Finished events
        </h2>

        {eventsQuery.isPending ? (
          <p role="status" className="text-sm text-ink-muted">
            Loading events…
          </p>
        ) : eventsQuery.isError ? (
          <p role="alert" className="text-sm text-danger">
            {errorMessage(eventsQuery.error, "Failed to load events.")}
          </p>
        ) : finishedEvents.length === 0 ? (
          <p className="text-sm text-ink-muted">
            No finished events yet. Mark an event finished on{" "}
            <Link to="/admin/events" className="font-semibold text-primary">
              the events screen
            </Link>{" "}
            before launching a feedback campaign.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {finishedEvents.map((event) => (
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
                  label="Launch or open campaign"
                  icon={<Rocket aria-hidden="true" className="size-4" />}
                  heading={`Feedback campaign for ${event.title}`}
                  description={
                    <>
                      Opens this event&rsquo;s campaign inbox. If the campaign
                      does not exist yet it is created. Either way, a
                      conversation and an intro message are queued for every
                      attendee who is marked present, opted in and has a phone
                      number and does not already have one. Existing
                      conversations are never duplicated or reopened.
                    </>
                  }
                  confirmLabel="Launch or open"
                  isPending={launchCampaign.isPending}
                  isDisabled={launchCampaign.isPending}
                  onConfirm={() => handleLaunch(event.id, event.title)}
                />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
