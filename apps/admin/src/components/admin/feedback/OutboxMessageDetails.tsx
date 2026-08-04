import { clsx } from "clsx";
import type { LucideIcon } from "lucide-react";
import {
  ClipboardList,
  ExternalLink,
  Fingerprint,
  MessageSquareDashed,
  MessageSquareQuote,
  MessagesSquare,
  Route,
  ScrollText,
  ServerCog,
} from "lucide-react";
import { useId, type ReactNode } from "react";
import { Link } from "react-router";

import type { FeedbackOutboxMessageDeliveryDtoOutput } from "../../../api/generated/model/feedbackOutboxMessageDeliveryDtoOutput";
import {
  deliveryActivityLines,
  outboundConversationStateFacts,
  outboundDecisionFacts,
  outboundDeliveryTimeline,
  outboxHistoryStatusBadge,
  outboxKindLabel,
  outboxProviderReadingBadge,
  OUTBOX_LOG_ABSENT_COPY,
  type OutboundLogFact,
} from "../../../features/feedback/outboxQueue";
import { JtsLiveIndicator } from "../../ui/JtsLiveIndicator";
import { CopyableId } from "./CopyableId";
import { FeedbackBadges } from "./FeedbackBadges";
import { ParticipantName } from "./ParticipantName";
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
  className,
}: {
  icon: LucideIcon;
  title: string;
  children: ReactNode;
  className?: string;
}) {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      className={clsx(
        "border-t border-border-subtle px-4 py-4 first:border-t-0",
        className,
      )}
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
 * What happened to this message, as a walk down the left edge with the gaps
 * between the steps called out.
 *
 * This replaced a stack of six labelled timestamps of which two named the same
 * instant and two were usually an em dash. The absolute time is still there —
 * it is evidence and the pane is where evidence lives — but it is no longer
 * what the eye lands on. `+0.4s` between «Written» and «Sent» is the whole
 * answer to «was delivery keeping up», and it was the one thing the stack of
 * absolute times made the reader compute for themselves.
 */
function DeliveryTimeline({
  message,
}: {
  message: FeedbackOutboxMessageDeliveryDtoOutput;
}) {
  const steps = outboundDeliveryTimeline({
    message,
    dispatch: message.dispatch,
  });

  return (
    <ol className="m-0 flex flex-col gap-0">
      {steps.map((step, index) => (
        <li key={step.key} className="flex gap-3">
          {/* The rail: a dot per step and a line joining it to the next. The
              last step grows no tail, because a tail into nothing reads as a
              step still to come. */}
          <span
            aria-hidden="true"
            className="flex flex-col items-center pt-1.5"
          >
            <span
              className={clsx(
                "size-2 shrink-0 rounded-full",
                step.terminal
                  ? "bg-danger"
                  : index === steps.length - 1
                    ? "bg-primary"
                    : "bg-border",
              )}
            />
            {index === steps.length - 1 ? null : (
              <span className="w-px flex-1 bg-border-subtle" />
            )}
          </span>

          <span className="flex min-w-0 flex-1 flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 pb-3 last:pb-0">
            <span className="flex items-baseline gap-2">
              <span
                className={clsx(
                  "text-sm font-semibold",
                  step.terminal ? "text-danger" : "text-ink",
                )}
              >
                {step.label}
              </span>
              {step.sincePrevious === null ? null : (
                <span className="text-xs font-bold tabular-nums text-primary">
                  {step.sincePrevious}
                </span>
              )}
            </span>
            <TimestampPill text={step.at} />
          </span>
        </li>
      ))}
    </ol>
  );
}

/**
 * What has happened to one outbound message.
 *
 * The pane is PostgreSQL all the way down: message, timeline, decision log and
 * durable dispatch activity.
 *
 * There is no spinner anywhere in here. Durable claims publish their deadline,
 * not worker liveness.
 */
export function OutboxMessageDetails({
  message,
  isRefreshing,
}: OutboxMessageDetailsProps) {
  const headingId = useId();
  const activity = deliveryActivityLines(message.dispatch);
  const providerReading = outboxProviderReadingBadge(message.deliveryStatus);
  const parked = message.campaignStatus !== "launched";

  return (
    <section
      aria-labelledby={headingId}
      className="flex min-h-0 flex-col overflow-hidden rounded-md border border-border bg-surface"
    >
      {/* Who, not what. The header used to lead with the kind and an age; the
          kind is a badge below and the age is the first gap in the timeline,
          while the person this was written to was nowhere on the pane at all. */}
      <header className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <h2 id={headingId} className="text-base leading-tight font-extrabold">
            <ParticipantName displayName={message.respondentDisplayName} />
          </h2>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-ink-muted">
            <span className="truncate">{message.eventTitle}</span>
            {message.phoneAtLaunch === null ? null : (
              <>
                <span aria-hidden="true">·</span>
                <span className="tabular-nums">{message.phoneAtLaunch}</span>
              </>
            )}
          </p>
        </div>
        <JtsLiveIndicator
          active={isRefreshing}
          label="This pane refreshes itself every few seconds."
        />
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* The message itself, first and in full.
            It is the only thing on this screen the participant ever saw, and
            for a year the pane that exists to explain a message never showed
            it. Everything below is context for these words. */}
        <DetailSection icon={MessageSquareQuote} title="What we sent">
          <blockquote className="m-0 rounded-md border border-border-subtle bg-surface-sunken px-3 py-2.5">
            <p className="m-0 text-sm leading-relaxed whitespace-pre-wrap text-ink">
              {message.body}
            </p>
          </blockquote>

          {/* One status line, not two rows of raw enum. The row's own status is
              the durable truth; the provider's reading appears only when the
              timeline below cannot already draw it. */}
          <FeedbackBadges
            badges={[
              outboxHistoryStatusBadge(message.status),
              {
                key: "kind",
                label: outboxKindLabel(message.kind),
                tone: "neutral",
              },
              ...(providerReading === null ? [] : [providerReading]),
              ...(parked
                ? [
                    {
                      key: "campaign",
                      label: `Campaign ${message.campaignStatus}`,
                      tone: "neutral" as const,
                    },
                  ]
                : []),
            ]}
            className="mt-3 flex flex-wrap items-center gap-1.5"
          />
        </DetailSection>

        <DetailSection icon={ClipboardList} title="What happened, and how fast">
          <DeliveryTimeline message={message} />
        </DetailSection>

        {/* Durable PostgreSQL, written in the same transaction as the row, so
            the decision appears before delivery activity. */}
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

        <DetailSection icon={ServerCog} title="Dispatch activity">
          <div
            className={clsx(
              "rounded-md px-3 py-2",
              activity.tone === "danger"
                ? "border border-danger/35 bg-danger-soft"
                : activity.tone === "pending"
                  ? "border border-warning-border bg-warning-soft"
                  : "border border-border-subtle bg-surface-sunken",
            )}
          >
            <p
              className={clsx(
                "text-sm font-bold",
                activity.tone === "danger"
                  ? "text-danger"
                  : activity.tone === "pending"
                    ? "text-warning"
                    : "text-ink",
              )}
            >
              {activity.state}
            </p>
            <p
              className={clsx(
                "mt-1 text-sm",
                activity.tone === "danger" ? "text-danger" : "text-ink-muted",
              )}
            >
              {activity.explanation}
            </p>
            {activity.timing ? (
              <p className="mt-1 text-sm text-ink-muted">{activity.timing}</p>
            ) : null}
            {activity.attempt ? (
              <p className="mt-1 text-sm text-ink-muted">{activity.attempt}</p>
            ) : null}
            {activity.recordedReason ? (
              <p
                className={clsx(
                  "mt-2 text-sm font-semibold",
                  activity.tone === "danger" ? "text-danger" : "text-ink-muted",
                )}
              >
                {activity.recordedReason}
              </p>
            ) : null}
          </div>
        </DetailSection>

        <DetailSection icon={Route} title="Where it belongs">
          {/* Only when it is a fact worth reading. A sentence saying the
              campaign is running and dispatch will get to this row was
              printed on every opened row, which taught operators to skip the
              paragraph that matters on the rows where it is not running. */}
          {parked ? (
            <p className="mb-3 text-sm text-ink-muted">
              The campaign is {message.campaignStatus}, so dispatch leaves this
              row where it is.
            </p>
          ) : null}
          <div className="flex flex-col gap-2">
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

        {/* Provider ids, in one strip at the bottom.
            They were labelled rows among the facts, competing with the
            times and the decision for the reader's attention — and not one of
            them is read on this screen. They exist to be pasted somewhere else,
            so they are grouped by that purpose and put where a reader arrives
            only when they went looking. */}
        <DetailSection
          icon={Fingerprint}
          title="Identifiers"
          className="bg-surface-sunken"
        >
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            <IdentifierChip
              label="Provider log"
              value={message.providerLogId}
              copyLabel="provider log id"
              absent="no provider call"
            />
            <IdentifierChip
              label="Provider message"
              value={message.providerMessageId}
              copyLabel="provider message id"
            />
          </div>
        </DetailSection>
      </div>
    </section>
  );
}

/** One id under its own micro-caps label, or the reason there is none. */
function IdentifierChip({
  label,
  value,
  copyLabel,
  absent = "—",
}: {
  label: string;
  value: string | null;
  copyLabel: string;
  absent?: string;
}) {
  return (
    <div className="min-w-0">
      <p className="mb-1 jts-overline text-ink-muted">{label}</p>
      {value === null ? (
        <p className="text-xs text-ink-subtle">{absent}</p>
      ) : (
        <CopyableId value={value} label={copyLabel} />
      )}
    </div>
  );
}

/** Shown until an operator opens a row; the list itself is the subject. */
export function OutboxMessageDetailsEmpty() {
  return (
    <section
      aria-label="Outbound message detail"
      className="flex min-h-40 flex-1 flex-col items-center justify-center rounded-md border border-border border-dashed bg-surface px-4 py-8 text-center"
    >
      <ClipboardList
        aria-hidden="true"
        className="mb-2 size-7 text-ink-subtle"
        strokeWidth={1.5}
      />
      <p className="text-sm font-semibold text-ink">
        Choose a message to read it
      </p>
      <p className="mt-1 max-w-[44ch] text-sm text-ink-muted">
        The list beside this reads only PostgreSQL. Opening a row is what shows
        the message itself, why it was written, and its dispatch state.
      </p>
    </section>
  );
}
