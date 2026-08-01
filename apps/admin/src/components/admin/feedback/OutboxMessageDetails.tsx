import { clsx } from "clsx";
import type { LucideIcon } from "lucide-react";
import {
  ClipboardList,
  ExternalLink,
  FileClock,
  MessageSquareDashed,
  MessagesSquare,
  Route,
  ScrollText,
  ServerCog,
} from "lucide-react";
import { useId, type ReactNode } from "react";
import { Link } from "react-router";

import type { FeedbackOutboxMessageDeliveryDtoOutput } from "../../../api/generated/model/feedbackOutboxMessageDeliveryDtoOutput";
import { formatPreciseTimestamp } from "../../../features/feedback/conversationView";
import {
  deliverJobLines,
  formatWaiting,
  outboundConversationStateFacts,
  outboundDecisionFacts,
  outboxKindLabel,
  OUTBOX_LOG_ABSENT_COPY,
  type OutboundLogFact,
} from "../../../features/feedback/outboxQueue";
import { JtsLiveIndicator } from "../../ui/JtsLiveIndicator";
import { CopyableId } from "./CopyableId";
import { ProviderMark } from "./ProviderMark";

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
 * One labelled fact. A missing value renders as an em dash, never as a blank
 * cell an operator has to interpret.
 *
 * `lead` is for the one fact a section turns on — the origin, which every other
 * fact in «Why this was sent» is a detail of. It is a half-step of weight, not
 * a second emphasis device.
 */
function FactRow({
  label,
  lead = false,
  children,
}: {
  label: string;
  lead?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <dt className="m-0 shrink-0 text-xs text-ink-muted">{label}</dt>
      <dd
        className={clsx(
          "m-0 min-w-0 text-right text-sm tabular-nums",
          lead ? "font-bold text-ink" : "text-ink",
        )}
      >
        {children}
      </dd>
    </div>
  );
}

/**
 * The quiet inset every machine value in this pane sits in: a time, a model, an
 * id. It is a hairline and a sunken fill and nothing more — enough for the eye
 * to find the times in a stack of facts without reading them, not enough to
 * outweigh the fact itself.
 *
 * Exported because the dev-only cookbook page is its second consumer.
 */
export const FACT_PILL =
  "inline-flex items-center gap-1.5 rounded-sm border border-border-subtle bg-surface-sunken px-1.5 py-px font-mono text-xs text-ink";

/**
 * An already-formatted time, in the pane's own pill.
 *
 * Exported because the dev-only cookbook page is its second consumer.
 */
export function TimestampPill({ text }: { text: string }) {
  return <span className={clsx(FACT_PILL, "whitespace-nowrap")}>{text}</span>;
}

/**
 * A row time, to the millisecond, or the em dash when there is none.
 *
 * Every timestamp in this pane is evidence rather than narration: a row written
 * and leased inside the same second, a provider call that landed between two
 * polls. The minute the rest of the admin shows would flatten exactly the
 * differences an operator opened this row to measure.
 */
function factTime(iso: string | null): ReactNode {
  return iso === null ? (
    "—"
  ) : (
    <TimestampPill text={formatPreciseTimestamp(iso)} />
  );
}

/**
 * Confidence as a number the eye can compare at a glance.
 *
 * The bar is decoration — `aria-hidden`, no label of its own — because the
 * percentage beside it is the fact and a reader should meet it once. A model
 * that reported nothing keeps the words and gets no track: an empty bar would
 * read as zero confidence, which is a different and much stronger claim.
 *
 * Exported because the dev-only cookbook page is its second consumer.
 */
export function ConfidenceValue({
  text,
  ratio,
}: {
  text: string;
  ratio: number | null;
}) {
  if (ratio === null) {
    return <>{text}</>;
  }

  return (
    <span className="inline-flex items-center gap-2">
      <span
        aria-hidden="true"
        className="h-1.5 w-14 shrink-0 overflow-hidden rounded-full bg-surface-sunken"
      >
        <span
          className="block h-full rounded-full bg-primary"
          style={{ width: `${Math.round(ratio * 100)}%` }}
        />
      </span>
      {text}
    </span>
  );
}

/**
 * How one decision-log fact paints, chosen by the kind the React-free builder
 * gave it. The data says what a fact *is*; only this decides what it looks
 * like.
 */
function FactValue({ fact }: { fact: OutboundLogFact }) {
  switch (fact.kind) {
    case "model":
      return (
        <span className={FACT_PILL}>
          <ProviderMark
            provider={fact.provider}
            className="size-3.5 shrink-0 text-ink-muted"
          />
          <span className="min-w-0 break-all">{fact.value}</span>
        </span>
      );
    case "timestamp":
      return <TimestampPill text={fact.value} />;
    case "id":
      return <CopyableId value={fact.value} label={fact.label.toLowerCase()} />;
    case "confidence":
      return <ConfidenceValue text={fact.value} ratio={fact.ratio} />;
    case "text":
      return <>{fact.value}</>;
  }
}

/**
 * What has happened to one outbound message.
 *
 * Two halves, kept visibly apart because their reliability is not the same.
 * PostgreSQL's half is durable and complete — the row's own facts, then the
 * decision that wrote it and the conversation state that decision was made
 * against, which is the only record of why this message exists at all. The
 * queue's half is a live read of a job that exists only while it is queued or
 * running — delivery jobs carry `attempts: 1` with immediate
 * `removeOnComplete` / `removeOnFail` — so it says
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
            <FactRow label="Row status">{message.status}</FactRow>
            <FactRow label="Delivery status">
              {message.deliveryStatus ?? "not reported"}
            </FactRow>
            <FactRow label="Created">{factTime(message.createdAt)}</FactRow>
            <FactRow label="Row last changed">
              {factTime(message.updatedAt)}
            </FactRow>
            <FactRow label="Delivery last changed">
              {factTime(message.deliveryUpdatedAt)}
            </FactRow>
            <FactRow label="Sent">{factTime(message.sentAt)}</FactRow>
            <FactRow label="Delivered">{factTime(message.deliveredAt)}</FactRow>
            <FactRow label="Read">{factTime(message.readAt)}</FactRow>
          </dl>
        </DetailSection>

        {/* Durable PostgreSQL, written in the same transaction as the row, so
            it belongs on this side of the pane's reliability line — beside the
            row's own facts and above the live queue read. */}
        <DetailSection icon={ScrollText} title="Why this was sent">
          {message.log === null ? (
            <p className="text-sm text-ink-muted">{OUTBOX_LOG_ABSENT_COPY}</p>
          ) : (
            <dl className="m-0 divide-y divide-border-subtle">
              {outboundDecisionFacts(message.log).map((fact, index) => (
                // The origin leads: every other fact in this section is a
                // detail of it, so it carries the weight and nothing else does.
                <FactRow key={fact.label} label={fact.label} lead={index === 0}>
                  <FactValue fact={fact} />
                </FactRow>
              ))}
            </dl>
          )}
        </DetailSection>

        {message.log === null ? null : (
          <DetailSection icon={MessagesSquare} title="Conversation as it stood">
            <dl className="m-0 divide-y divide-border-subtle">
              {outboundConversationStateFacts(
                message.log.conversationState,
              ).map((fact) => (
                <FactRow key={fact.label} label={fact.label}>
                  <FactValue fact={fact} />
                </FactRow>
              ))}
            </dl>
            <p className="mt-3 text-xs text-ink-subtle">
              What the writer saw when it queued this message — not what the
              conversation looks like now.
            </p>
          </DetailSection>
        )}

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
            <FactRow label="Job id">
              <CopyableId value={message.job.id} label="job id" />
            </FactRow>
            <FactRow label="Provider log id">
              {message.providerLogId === null ? (
                "no provider call recorded"
              ) : (
                <CopyableId
                  value={message.providerLogId}
                  label="provider log id"
                />
              )}
            </FactRow>
            <FactRow label="Provider message id">
              {message.providerMessageId === null ? (
                "—"
              ) : (
                <CopyableId
                  value={message.providerMessageId}
                  label="provider message id"
                />
              )}
            </FactRow>
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
