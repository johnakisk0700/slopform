import { clsx } from "clsx";
import type { LucideIcon } from "lucide-react";
import {
  ClipboardList,
  ExternalLink,
  FileClock,
  MessageSquareDashed,
  Route,
  ServerCog,
} from "lucide-react";
import { useId, type ReactNode } from "react";
import { Link } from "react-router";

import type { FeedbackOutboxMessageDeliveryDtoOutput } from "../../../api/generated/model/feedbackOutboxMessageDeliveryDtoOutput";
import { formatTimestamp } from "../../../features/feedback/conversationView";
import {
  deliverJobLines,
  formatWaiting,
  outboxKindLabel,
} from "../../../features/feedback/outboxQueue";
import { JtsLiveIndicator } from "../../ui/JtsLiveIndicator";

interface OutboxMessageDetailsProps {
  message: FeedbackOutboxMessageDeliveryDtoOutput;
  isRefreshing: boolean;
}

/** One section of the pane, matching the details-pane grammar of the inbox. */
function DetailSection({
  icon: Icon,
  title,
  children,
}: {
  icon: LucideIcon;
  title: string;
  children: ReactNode;
}) {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      className="border-t border-border-subtle px-4 py-4 first:border-t-0"
    >
      <h3
        id={headingId}
        className="mb-3 flex items-center gap-2 jts-overline text-ink-muted"
      >
        <Icon aria-hidden="true" className="size-4 shrink-0" />
        {title}
      </h3>
      {children}
    </section>
  );
}

/**
 * One labelled fact and its time. A missing time renders as an em dash, never
 * as a blank cell an operator has to interpret.
 */
function FactRow({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <dt className="m-0 shrink-0 text-xs text-ink-muted">{label}</dt>
      <dd className="m-0 min-w-0 text-right text-sm text-ink tabular-nums">
        {value ?? "—"}
      </dd>
    </div>
  );
}

/**
 * What has happened to one outbound message.
 *
 * Two halves, kept visibly apart because their reliability is not the same.
 * PostgreSQL's half is durable and complete. The queue's half is a live read of
 * a job that exists only while it is queued or running — delivery jobs carry
 * `attempts: 1` with immediate `removeOnComplete` / `removeOnFail` — so it says
 * «άγνωστο» whenever the job is gone and states which indistinguishable
 * situations produced that, instead of dressing absence up as a verdict.
 *
 * There is no spinner anywhere in here. A dead worker and a busy one look
 * identical from Redis, so the pane gives a state and a time or admits it does
 * not know.
 */
export function OutboxMessageDetails({
  message,
  isRefreshing,
}: OutboxMessageDetailsProps) {
  const headingId = useId();
  const job = deliverJobLines(message);

  return (
    <section
      aria-labelledby={headingId}
      className="flex max-h-[78vh] min-h-0 flex-col overflow-hidden rounded-md border border-border bg-surface"
    >
      <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
        <h2
          id={headingId}
          className="flex items-center gap-2 jts-overline text-ink-muted"
        >
          <ClipboardList aria-hidden="true" className="size-4 shrink-0" />
          {outboxKindLabel(message.kind)} · waiting{" "}
          {formatWaiting(message.waitingSeconds)}
        </h2>
        <JtsLiveIndicator
          active={isRefreshing}
          label="This pane refreshes itself every few seconds."
        />
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <DetailSection icon={FileClock} title="Outbox row">
          <dl className="m-0 divide-y divide-border-subtle">
            <FactRow label="Row status" value={message.status} />
            <FactRow
              label="Delivery status"
              value={message.deliveryStatus ?? "not reported"}
            />
            <FactRow
              label="Created"
              value={formatTimestamp(message.createdAt)}
            />
            <FactRow
              label="Row last changed"
              value={formatTimestamp(message.updatedAt)}
            />
            <FactRow
              label="Delivery last changed"
              value={
                message.deliveryUpdatedAt === null
                  ? null
                  : formatTimestamp(message.deliveryUpdatedAt)
              }
            />
            <FactRow
              label="Sent"
              value={
                message.sentAt === null ? null : formatTimestamp(message.sentAt)
              }
            />
            <FactRow
              label="Delivered"
              value={
                message.deliveredAt === null
                  ? null
                  : formatTimestamp(message.deliveredAt)
              }
            />
            <FactRow
              label="Read"
              value={
                message.readAt === null ? null : formatTimestamp(message.readAt)
              }
            />
          </dl>
        </DetailSection>

        <DetailSection icon={ServerCog} title="Delivery job">
          <div
            className={clsx(
              "rounded-md px-3 py-2",
              job.tone === "danger"
                ? "border border-danger/35 bg-danger-soft"
                : job.tone === "pending"
                  ? "border border-warning-border bg-warning-soft"
                  : "border border-border-subtle bg-surface-sunken",
            )}
          >
            <p
              className={clsx(
                "text-sm font-bold",
                job.tone === "danger"
                  ? "text-danger"
                  : job.tone === "pending"
                    ? "text-warning"
                    : "text-ink",
              )}
            >
              {job.state}
            </p>
            <p
              className={clsx(
                "mt-1 text-sm",
                job.tone === "danger" ? "text-danger" : "text-ink-muted",
              )}
            >
              {job.explanation}
            </p>
            {job.timing ? (
              <p className="mt-1 text-sm text-ink-muted">{job.timing}</p>
            ) : null}
            {job.attempt ? (
              <p className="mt-1 text-sm text-ink-muted">{job.attempt}</p>
            ) : null}
            {job.failure ? (
              <p className="mt-2 text-sm font-semibold text-danger">
                {job.failure}
              </p>
            ) : null}
          </div>

          <dl className="m-0 mt-3 divide-y divide-border-subtle">
            <FactRow label="Job id" value={message.job.id} />
            <FactRow
              label="Provider log id"
              value={message.providerLogId ?? "no provider call recorded"}
            />
            <FactRow
              label="Provider message id"
              value={message.providerMessageId}
            />
          </dl>

          {/* The honest limit of this pane, stated where an operator meets it
              rather than in a document nobody has open. */}
          <p className="mt-3 text-xs text-ink-subtle">
            Retry history is not stored anywhere. The outbox table keeps no
            attempt counter, and the delivery job is removed from Redis the
            moment it ends, so a job that has finished or was lost is «άγνωστο»
            — not proof that nothing happened.
          </p>
        </DetailSection>

        <DetailSection icon={Route} title="Where it belongs">
          <p className="text-sm text-ink-muted">
            {message.campaignStatus === "launched"
              ? "The campaign is running, so the relay leases this row as soon as it can."
              : `The campaign is ${message.campaignStatus}, so the relay leaves this row where it is.`}
          </p>
          <div className="mt-3 flex flex-col gap-2">
            <Link
              to={`/admin/feedback/${message.campaignId}?conversation=${message.conversationId}`}
              className="inline-flex items-center gap-1.5 text-sm font-semibold text-primary underline-offset-2 hover:underline"
            >
              <MessageSquareDashed
                aria-hidden="true"
                className="size-4 shrink-0"
              />
              Open this conversation
            </Link>
            <Link
              to={`/admin/feedback/${message.campaignId}`}
              className="inline-flex items-center gap-1.5 text-sm font-semibold text-primary underline-offset-2 hover:underline"
            >
              <ExternalLink aria-hidden="true" className="size-4 shrink-0" />
              Open the campaign inbox
            </Link>
          </div>
        </DetailSection>
      </div>
    </section>
  );
}

/** Shown until an operator opens a row; the queue itself is the subject. */
export function OutboxMessageDetailsEmpty() {
  return (
    <section
      aria-label="Outbound message detail"
      className="flex min-h-40 flex-col items-center justify-center rounded-md border border-border border-dashed bg-surface px-4 py-8 text-center"
    >
      <ClipboardList
        aria-hidden="true"
        className="mb-2 size-7 text-ink-subtle"
        strokeWidth={1.5}
      />
      <p className="text-sm font-semibold text-ink">
        Choose a message to see its delivery attempts
      </p>
      <p className="mt-1 max-w-[40ch] text-sm text-ink-muted">
        The queue above reads only PostgreSQL. Opening a row is what looks up
        its live job state.
      </p>
    </section>
  );
}
