import { Button } from "@heroui/react";
import clsx from "clsx";
import {
  Calendar as CalendarIcon,
  MessageCircleWarning,
  RefreshCw,
  SendHorizontal,
  Users,
} from "lucide-react";
import { Link } from "react-router";

import { useGetOverview } from "../../api/generated/overview";
import { JtsPageHeader } from "../../components/ui/JtsPageHeader";
import { JtsStat } from "../../components/ui/JtsStat";
import { eventStatusLabel } from "../../features/event/eventStatus";
import { usePageMeta } from "../../lib/usePageMeta";

import {
  buildAttentionQueue,
  formatDate,
  formatDateTime,
} from "./overviewData";
import { CopperNote, FocusCard, QueueRow, Stamp } from "./OverviewPanels";

/**
 * The Operations control landing view: exact platform aggregates for events,
 * participants, feedback conversations and outbound delivery.
 */
export function OverviewPage() {
  usePageMeta(
    "Operations control",
    "Private Slopform event operations workspace.",
  );

  const overviewQuery = useGetOverview({
    query: {
      staleTime: 30_000,
      refetchOnWindowFocus: true,
    },
  });

  const data = overviewQuery.data;
  const refreshing = overviewQuery.isFetching && !overviewQuery.isPending;
  const attentionQueue = data ? buildAttentionQueue(data) : [];
  const nextDinner = data?.events.nextScheduled ?? null;

  return (
    <div className="flex flex-col gap-6">
      <JtsPageHeader
        title="Operations control"
        description="A dinner is six strangers and a hundred small decisions. This is where the decisions get made."
        actions={
          <Button
            size="sm"
            variant="secondary"
            className="shrink-0"
            onPress={() => {
              void overviewQuery.refetch();
            }}
            isDisabled={overviewQuery.isFetching}
            aria-label="Refresh overview"
          >
            <RefreshCw
              aria-hidden="true"
              className={clsx("size-4", refreshing && "animate-spin")}
            />
            Refresh
          </Button>
        }
      />

      {data ? (
        <CopperNote>
          Snapshot at {formatDateTime(data.observedAt)}. Counts are exact
          aggregates — refresh to read the stores again.
        </CopperNote>
      ) : null}

      {overviewQuery.isPending ? (
        <p role="status" className="text-sm text-ink-muted">
          Loading operations snapshot…
        </p>
      ) : null}

      {overviewQuery.isError ? (
        <p role="alert" className="text-sm text-danger">
          The overview could not be loaded. Refresh to try again.
        </p>
      ) : null}

      {data ? (
        <>
          <dl
            aria-label="Operations summary"
            className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4"
          >
            <JtsStat
              label="Scheduled events"
              value={data.events.byStatus.scheduled}
              detail={`${data.events.total} events total`}
              icon={CalendarIcon}
            />
            <JtsStat
              label="Participants"
              value={data.participants.total}
              detail={`${data.participants.feedbackContactableCount} feedback-contactable`}
              icon={Users}
            />
            <JtsStat
              label="Needs attention"
              value={data.feedback.conversations.needsAttention}
              detail={
                data.feedback.conversations.extractionParked > 0
                  ? `${data.feedback.conversations.extractionParked} extraction parked`
                  : `${data.feedback.conversations.open} conversations open`
              }
              {...(data.feedback.conversations.needsAttention > 0
                ? { tone: "warning" as const }
                : {})}
              icon={MessageCircleWarning}
            />
            <JtsStat
              label="Undelivered messages"
              value={data.feedback.outbox.totalUndelivered}
              detail={
                data.feedback.outbox.failedLast24Hours > 0
                  ? `${data.feedback.outbox.failedLast24Hours} failed in 24h`
                  : `${data.feedback.campaigns.byStatus.launched} campaigns launched`
              }
              {...(data.feedback.outbox.totalUndelivered > 0
                ? { tone: "warning" as const }
                : {})}
              icon={SendHorizontal}
            />
          </dl>

          <section
            aria-label="Operational focus"
            className="grid gap-6 md:grid-cols-2"
          >
            <FocusCard kicker="Immediate event context" title="Next dinner">
              {nextDinner ? (
                <div className="grid gap-5">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex min-w-0 flex-col">
                      <strong className="text-base font-bold text-ink">
                        {nextDinner.title}
                      </strong>
                      <span className="text-sm text-ink-muted">
                        {nextDinner.venueLabel
                          ? `${nextDinner.venueLabel} · `
                          : null}
                        {formatDateTime(nextDinner.startsAt)}
                      </span>
                    </div>
                    <Stamp tone="info">Scheduled</Stamp>
                  </div>
                  <div className="flex items-baseline justify-between gap-4">
                    <span className="jts-overline text-ink-muted">
                      Attendees assigned
                    </span>
                    <strong className="text-sm font-bold tabular-nums text-ink">
                      {nextDinner.attendeeCount}
                    </strong>
                  </div>
                  <Link
                    to={`/admin/events/${nextDinner.id}`}
                    className="text-sm font-semibold text-primary underline-offset-4 hover:underline"
                  >
                    Open event
                  </Link>
                </div>
              ) : (
                <p className="text-sm text-ink-muted">
                  No scheduled dinner yet.{" "}
                  <Link
                    to="/admin/events"
                    className="font-semibold text-primary underline-offset-4 hover:underline"
                  >
                    Go to events
                  </Link>
                </p>
              )}
            </FocusCard>

            <FocusCard kicker="Operator queue" title="Needs attention">
              {attentionQueue.length > 0 ? (
                <ul className="divide-y divide-dotted divide-border-strong">
                  {attentionQueue.map(({ key, ...item }) => (
                    <QueueRow key={key} {...item} />
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-ink-muted">
                  Nothing is asking for an operator right now.
                </p>
              )}
            </FocusCard>
          </section>

          <section
            aria-label="Platform workflow"
            className="grid gap-4 rounded-md border border-border bg-surface p-6 md:grid-cols-2"
          >
            <div>
              <p className="mb-2 jts-overline text-ink-muted">Event stages</p>
              <dl className="grid gap-2 text-sm">
                {(["draft", "scheduled", "finished", "cancelled"] as const).map(
                  (status) => (
                    <div
                      key={status}
                      className="flex items-baseline justify-between gap-4"
                    >
                      <dt className="text-ink-muted">
                        {eventStatusLabel(status)}
                      </dt>
                      <dd className="m-0 font-bold tabular-nums text-ink">
                        {data.events.byStatus[status]}
                      </dd>
                    </div>
                  ),
                )}
              </dl>
            </div>
            <div>
              <p className="mb-2 jts-overline text-ink-muted">Feedback loop</p>
              <dl className="grid gap-2 text-sm">
                <div className="flex items-baseline justify-between gap-4">
                  <dt className="text-ink-muted">Campaigns</dt>
                  <dd className="m-0 font-bold tabular-nums text-ink">
                    {data.feedback.campaigns.total}
                  </dd>
                </div>
                <div className="flex items-baseline justify-between gap-4">
                  <dt className="text-ink-muted">Conversations</dt>
                  <dd className="m-0 font-bold tabular-nums text-ink">
                    {data.feedback.conversations.total}
                  </dd>
                </div>
                <div className="flex items-baseline justify-between gap-4">
                  <dt className="text-ink-muted">Completed</dt>
                  <dd className="m-0 font-bold tabular-nums text-ink">
                    {data.feedback.conversations.byClosedReason.completed}
                  </dd>
                </div>
                <div className="flex items-baseline justify-between gap-4">
                  <dt className="text-ink-muted">Summaries ready</dt>
                  <dd className="m-0 font-bold tabular-nums text-ink">
                    {data.feedback.summaries.ready}
                  </dd>
                </div>
                <div className="flex items-baseline justify-between gap-4">
                  <dt className="text-ink-muted">Present / assigned</dt>
                  <dd className="m-0 font-bold tabular-nums text-ink">
                    {data.events.presentCount} / {data.events.attendeeCount}
                  </dd>
                </div>
              </dl>
              {data.events.finishedWithoutFeedbackCampaignCount > 0 ? (
                <p className="mt-3 text-xs text-ink-muted">
                  {data.events.finishedWithoutFeedbackCampaignCount} finished
                  dinner
                  {data.events.finishedWithoutFeedbackCampaignCount === 1
                    ? ""
                    : "s"}{" "}
                  still without a feedback campaign
                  {nextDinner
                    ? ` · next ${formatDate(nextDinner.startsAt)}`
                    : ""}
                  .
                </p>
              ) : null}
            </div>
          </section>
        </>
      ) : null}
    </div>
  );
}
