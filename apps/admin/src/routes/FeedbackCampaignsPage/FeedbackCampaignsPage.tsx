import { ToggleButton, ToggleButtonGroup } from "@heroui/react";
import { Rocket } from "lucide-react";
import { Link } from "react-router";

import { ConfirmAction } from "../../components/admin/feedback/ConfirmAction";
import { JtsPageHeader } from "../../components/ui/JtsPageHeader";
import { apiErrorMessage } from "../../lib/api";
import { usePageMeta } from "../../lib/usePageMeta";

import { CampaignCard, CampaignSection } from "./CampaignCard";
import {
  CAMPAIGN_SECTIONS,
  CHOICE_CHIP,
  ORDERING_OPTIONS,
} from "./campaignSections";
import { useFeedbackCampaignsControls } from "./useFeedbackCampaignsControls";

export function FeedbackCampaignsPage() {
  const {
    launchError,
    ordering,
    setOrdering,
    orderingLabelId,
    campaignsQuery,
    eventsQuery,
    launchCampaign,
    campaigns,
    venueByEventId,
    campaignsByStatus,
    finishedEventsWithoutCampaign,
    handleLaunch,
  } = useFeedbackCampaignsControls();

  usePageMeta(
    "Feedback campaigns",
    "Open a post-event feedback campaign's conversation inbox.",
  );

  return (
    <div className="flex flex-col gap-6">
      <JtsPageHeader
        eyebrow="Post-event feedback"
        title="Feedback campaigns"
        description="One dinner, one campaign, one chance to ask. Open a campaign to read what came back — and to step in where the bot should not answer alone."
      />

      {launchError ? (
        <p role="alert" className="text-sm text-danger">
          {launchError}
        </p>
      ) : null}

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
        <>
          {/* Only worth offering once there is more than one status to group
              by. With every campaign launched, the two views render the same
              screen, and a control that changes nothing is chrome charging
              rent on the row above the content. */}
          {campaignsByStatus.size > 1 ? (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span
                id={orderingLabelId}
                className="jts-overline text-ink-muted"
              >
                Campaigns {campaigns.length}
              </span>
              <ToggleButtonGroup
                aria-labelledby={orderingLabelId}
                selectionMode="single"
                disallowEmptySelection
                isDetached
                selectedKeys={[ordering]}
                onSelectionChange={(keys) => {
                  const [next] = keys;
                  if (next === "status" || next === "date") setOrdering(next);
                }}
              >
                {ORDERING_OPTIONS.map(({ value, label, Icon }) => (
                  <ToggleButton
                    key={value}
                    id={value}
                    size="sm"
                    className={CHOICE_CHIP}
                  >
                    <Icon aria-hidden="true" className="size-3.5 shrink-0" />
                    {label}
                  </ToggleButton>
                ))}
              </ToggleButtonGroup>
            </div>
          ) : null}

          {ordering === "date" ? (
            /* One run, newest first — which is the order the API already
               returns, so this view sorts nothing and cannot disagree with the
               sectioned one. The cards carry their status badge here because
               the headings that were naming it are gone, and a state must
               never be knowable from a tint alone. */
            <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {campaigns.map((entry) => (
                <li key={entry.id}>
                  <CampaignCard
                    entry={entry}
                    venue={venueByEventId.get(entry.eventId) ?? null}
                    showStatus
                  />
                </li>
              ))}
            </ul>
          ) : (
            /* One section per status, and an empty status renders nothing at
               all — not a heading over «None». A workspace where every campaign
               is running should look like one screen of live campaigns, not
               like a form with two blanks in it. */
            CAMPAIGN_SECTIONS.map((spec) => {
              const rows = campaignsByStatus.get(spec.status) ?? [];
              if (rows.length === 0) return null;
              return (
                <CampaignSection
                  key={spec.status}
                  spec={spec}
                  rows={rows}
                  venueByEventId={venueByEventId}
                />
              );
            })
          )}
        </>
      )}

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
