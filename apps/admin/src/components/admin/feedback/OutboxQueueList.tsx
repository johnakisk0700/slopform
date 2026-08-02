import { clsx } from "clsx";
import { MailCheck, SendHorizontal } from "lucide-react";
import { useId } from "react";

import type { FeedbackOutboxQueueDtoOutputItemsItem } from "../../../api/generated/model/feedbackOutboxQueueDtoOutputItemsItem";
import {
  describeWaiting,
  formatWaiting,
  outboxKindLabel,
  outboxStatusBadge,
  outboxWaitingTone,
  type OutboxWaitingTone,
} from "../../../features/feedback/outboxQueue";
import { JtsLiveIndicator } from "../../ui/JtsLiveIndicator";
import { FeedbackBadges } from "./FeedbackBadges";
import { ParticipantName } from "./ParticipantName";

interface OutboxQueueListProps {
  items: readonly FeedbackOutboxQueueDtoOutputItemsItem[];
  selectedId: string | null;
  onSelect: (outboxId: string) => void;
  loading: boolean;
  error: string | null;
  /** True when the endpoint capped the page below the real backlog. */
  truncated: boolean;
  total: number;
  isRefreshing: boolean;
}

/**
 * How each age reads.
 *
 * Only two tiers raise their voice, and `parked` deliberately lowers it: a row
 * the relay is refusing to lease because its campaign is paused is doing what
 * it was told, and colouring that like an incident would teach an operator that
 * the colour means nothing.
 */
const WAITING_TONES: Record<OutboxWaitingTone, string> = {
  parked: "text-ink-muted",
  fresh: "text-ink",
  slow: "text-warning",
  stalled: "text-danger",
};

/** The age cell is the loudest thing in the row once it stops being ordinary. */
const WAITING_EMPHASIS: Record<OutboxWaitingTone, string> = {
  parked: "font-semibold",
  fresh: "font-semibold",
  slow: "font-extrabold",
  stalled: "font-extrabold",
};

/**
 * Outbound messages that have not reached the participant, oldest first.
 *
 * The age is the subject of the screen, so it is the one column with its own
 * scale: an operator has to tell five seconds from three minutes without
 * reading, and the endpoint already sorts by it. Every other fact on the row —
 * who is waiting, which campaign, what kind of message — exists to answer "and
 * who does that affect", which is the question Bull Board cannot answer at all.
 *
 * The list is **not** a live region. Every age changes on every poll by
 * construction, so a polite announcement would fire forever; the hidden
 * sentence on {@link JtsLiveIndicator} states that the pane refreshes itself and
 * the ages are read on demand.
 */
export function OutboxQueueList({
  items,
  selectedId,
  onSelect,
  loading,
  error,
  truncated,
  total,
  isRefreshing,
}: OutboxQueueListProps) {
  const headingId = useId();

  return (
    <section
      aria-labelledby={headingId}
      className="flex min-h-0 flex-col overflow-hidden rounded-md border border-border bg-surface"
    >
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2.5">
        <h2
          id={headingId}
          className="flex min-w-0 items-center gap-2 jts-overline text-ink-muted"
        >
          <SendHorizontal aria-hidden="true" className="size-4 shrink-0" />
          <span className="truncate">Still waiting</span>
          <span className="shrink-0 font-bold tabular-nums opacity-70">
            {total}
          </span>
        </h2>
        <JtsLiveIndicator
          active={isRefreshing}
          label="This list refreshes itself every few seconds; ages are measured on the server."
        />
      </div>

      {error ? (
        <p role="alert" className="px-4 py-6 text-sm text-danger">
          {error}
        </p>
      ) : null}

      {loading && items.length === 0 ? (
        <p role="status" className="px-4 py-6 text-sm text-ink-muted">
          Loading the outbound queue…
        </p>
      ) : null}

      {!loading && !error && items.length === 0 ? (
        <div className="flex flex-col items-center px-4 py-8 text-center">
          {/* Not the header's own glyph — a repeated icon inside its own
              section has stopped carrying information. */}
          <MailCheck
            aria-hidden="true"
            className="mb-2 size-7 text-ink-subtle"
            strokeWidth={1.5}
          />
          <p className="text-sm font-semibold text-ink">Nothing is waiting</p>
          <p className="mt-1 text-sm text-ink-muted">
            Every outbound feedback message has either reached the participant
            or been cancelled.
          </p>
        </div>
      ) : null}

      {items.length > 0 ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <ul>
            {items.map((item) => {
              const tone = outboxWaitingTone(item);
              const isSelected = item.id === selectedId;
              const paused = item.campaignStatus !== "launched";

              return (
                <li
                  key={item.id}
                  className="border-b border-border-subtle last:border-b-0"
                >
                  <button
                    type="button"
                    {...(isSelected ? { "aria-current": true } : {})}
                    onClick={() => onSelect(item.id)}
                    className={clsx(
                      "block w-full cursor-pointer px-3 py-2 text-left transition-colors",
                      isSelected
                        ? "bg-primary-soft"
                        : "hover:bg-surface-sunken",
                    )}
                  >
                    <span className="flex items-baseline justify-between gap-2">
                      <span
                        className={clsx(
                          "line-clamp-1 min-w-0 flex-1 text-sm leading-snug font-bold break-words",
                          isSelected ? "text-primary" : "text-ink",
                        )}
                      >
                        <ParticipantName
                          displayName={item.respondentDisplayName}
                        />
                      </span>
                      {/* The number and the spoken form together: `2m 27s`
                          scans, but a reader would voice it as punctuation. */}
                      <span
                        className={clsx(
                          "shrink-0 text-sm tabular-nums",
                          WAITING_TONES[tone],
                          WAITING_EMPHASIS[tone],
                        )}
                      >
                        <span aria-hidden="true">
                          {formatWaiting(item.waitingSeconds)}
                        </span>
                        <span className="sr-only">
                          waiting {describeWaiting(item.waitingSeconds)}
                        </span>
                      </span>
                    </span>

                    <span className="mt-1 flex items-center gap-1.5 text-xs text-ink-muted">
                      <span className="shrink-0 font-semibold">
                        {outboxKindLabel(item.kind)}
                      </span>
                      <span aria-hidden="true">·</span>
                      {/* The phone number left this row with the column's
                          width. It is on the opened message, beside the
                          conversation it can actually be used from. */}
                      <span className="min-w-0 truncate">
                        {item.eventTitle}
                      </span>
                    </span>

                    <FeedbackBadges
                      badges={[
                        outboxStatusBadge(item.status),
                        ...(paused
                          ? [
                              {
                                key: "campaign",
                                label: "Campaign paused",
                                tone: "neutral" as const,
                              },
                            ]
                          : []),
                      ]}
                      className="mt-1.5 flex flex-wrap items-center gap-1.5"
                    />
                  </button>
                </li>
              );
            })}
          </ul>

          {truncated ? (
            <p className="border-t border-border-subtle bg-surface-sunken px-4 py-2.5 text-xs text-ink-muted">
              Showing the {items.length} oldest of {total}. The rest are newer
              than these.
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
