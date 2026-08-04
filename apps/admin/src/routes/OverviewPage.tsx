import { type ReactNode } from "react";
import { Button, Chip } from "@heroui/react";
import { Link } from "react-router";
import {
  AlertTriangle,
  Calendar as CalendarIcon,
  CircleCheck,
  Inbox,
  type LucideIcon,
  MessageCircleWarning,
  Pause,
  RefreshCw,
  SendHorizontal,
  Users,
} from "lucide-react";
import clsx from "clsx";

import { useGetOverview } from "../api/generated/overview";
import type { OverviewDtoOutput } from "../api/generated/model/overviewDtoOutput";
import { JtsStat } from "../components/ui/JtsStat";
import { JtsPageHeader } from "../components/ui/JtsPageHeader";
import { eventStatusLabel } from "../features/event/eventStatus";
import { attentionReasonLabel } from "../features/feedback/labels";
import { usePageMeta } from "../lib/usePageMeta";

/** Ledger-stamp tones — the status hues sanctioned by the design contract. */
type StampTone = "primary" | "success" | "warning" | "danger" | "info";

const stampToneText: Record<StampTone, string> = {
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

function formatDateTime(value: string): string {
  return dateTimeFormatter.format(new Date(value));
}

function formatDate(value: string): string {
  return dateFormatter.format(new Date(value));
}

/**
 * A ledger "rubber stamp": a HeroUI Chip flattened to a transparent, outlined,
 * uppercase tag whose single hue is carried by `currentColor`.
 */
function Stamp({ tone, children }: { tone: StampTone; children: ReactNode }) {
  return (
    <Chip
      variant="tertiary"
      className={clsx(
        "rounded-sm border border-current/40 bg-transparent px-2 py-0.5 text-[0.7rem] font-extrabold uppercase tracking-[0.05em]",
        stampToneText[tone],
      )}
    >
      {children}
    </Chip>
  );
}

/** One row in the "Needs attention" operator queue. */
interface QueueItem {
  key: string;
  icon: LucideIcon;
  title: string;
  subtitle: string;
  stampTone: StampTone;
  stampLabel: ReactNode;
  to?: string;
}

/** A single receipt-ruled row in the operator attention queue. */
function QueueRow({
  icon: Icon,
  title,
  subtitle,
  stampTone,
  stampLabel,
  to,
}: QueueItem) {
  const body = (
    <>
      <span
        aria-hidden="true"
        className="flex size-9 shrink-0 items-center justify-center rounded-md bg-primary-soft text-primary"
      >
        <Icon className="size-4" />
      </span>
      <span className="flex min-w-0 flex-col">
        <strong className="font-bold text-ink">{title}</strong>
        <small className="text-xs text-ink-muted">{subtitle}</small>
      </span>
      <span className="ml-auto">
        <Stamp tone={stampTone}>{stampLabel}</Stamp>
      </span>
    </>
  );

  if (to) {
    return (
      <li className="first:pt-0 last:pb-0">
        <Link
          to={to}
          className="flex items-center gap-3 py-3 text-inherit no-underline focus-visible:outline-none"
        >
          {body}
        </Link>
      </li>
    );
  }

  return (
    <li className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
      {body}
    </li>
  );
}

/** A copper informational aside (contract motif #6). */
function CopperNote({ children }: { children: ReactNode }) {
  return (
    <div
      role="note"
      className="flex items-start gap-3 rounded-md border border-copper/35 bg-copper-soft px-4 py-3 text-sm text-ink-muted"
    >
      <Inbox
        aria-hidden="true"
        className="mt-0.5 size-4 shrink-0 text-copper"
      />
      <span>{children}</span>
    </div>
  );
}

/** A focus card: kicker rendered above the title, optional wine left marker. */
function FocusCard({
  kicker,
  title,
  primary = false,
  children,
}: {
  kicker: string;
  title: string;
  primary?: boolean;
  children: ReactNode;
}) {
  return (
    <article
      className={clsx(
        "rounded-md border border-border bg-surface p-6",
        primary && "border-l-[3px] border-l-primary",
      )}
    >
      <p className="mb-2 text-xs font-bold uppercase tracking-wide text-ink-muted">
        {kicker}
      </p>
      <h2 className="mb-4 text-[1.05rem] font-bold tracking-tight text-ink">
        {title}
      </h2>
      {children}
    </article>
  );
}

function buildAttentionQueue(data: OverviewDtoOutput): QueueItem[] {
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

/**
 * The Operations control landing view: exact platform aggregates for events,
 * participants, feedback conversations and outbound delivery.
 */
export function OverviewPage() {
  usePageMeta(
    "Operations control",
    "Private Join The Six event operations workspace.",
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
        eyebrow="Admin workspace"
        title="Operations control"
        description="A dinner is six strangers and a hundred small decisions. This is where the decisions get made."
        actions={
          <Button
            variant="outline"
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
            <FocusCard
              kicker="Immediate event context"
              title="Next dinner"
              primary
            >
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
                    <span className="text-xs font-bold uppercase tracking-wide text-ink-muted">
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
              <p className="mb-2 text-xs font-bold uppercase tracking-wide text-ink-muted">
                Event stages
              </p>
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
              <p className="mb-2 text-xs font-bold uppercase tracking-wide text-ink-muted">
                Feedback loop
              </p>
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
