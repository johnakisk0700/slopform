import { clsx } from "clsx";
import { Inbox, ScrollText } from "lucide-react";
import { useId } from "react";

import type { FeedbackOutboxHistoryDtoOutputItemsItem } from "../../../api/generated/model/feedbackOutboxHistoryDtoOutputItemsItem";
import { formatTimestamp } from "../../../features/feedback/conversationView";
import {
  outboundOriginLabel,
  outboxHistoryStatusBadge,
  outboxKindLabel,
} from "../../../features/feedback/outboxQueue";
import { JtsLiveIndicator } from "../../ui/JtsLiveIndicator";
import { FeedbackBadges } from "./FeedbackBadges";
import { ParticipantName } from "./ParticipantName";

interface OutboxHistoryListProps {
  items: readonly FeedbackOutboxHistoryDtoOutputItemsItem[];
  selectedId: string | null;
  onSelect: (outboxId: string) => void;
  loading: boolean;
  error: string | null;
  /** True when the endpoint capped the page below the real total. */
  truncated: boolean;
  total: number;
  isRefreshing: boolean;
}

/**
 * Every outbound message ever written, newest first, delivered or not.
 *
 * The queue list answers «who is waiting right now» and empties itself the
 * moment delivery is healthy — which made the decision log unreachable the
 * first time anybody looked for it. This list is the other half: each row
 * carries the log's origin, so «why was this written» is already on the page
 * before a row is opened.
 *
 * Same restraint as the queue list: no live region (rows arrive on every
 * poll), one `aria-current` selection, and opening a row is what spends the
 * single Redis lookup.
 */
export function OutboxHistoryList({
  items,
  selectedId,
  onSelect,
  loading,
  error,
  truncated,
  total,
  isRefreshing,
}: OutboxHistoryListProps) {
  const headingId = useId();

  return (
    <section
      aria-labelledby={headingId}
      className="flex max-h-[78vh] min-h-0 flex-col overflow-hidden rounded-md border border-border bg-surface"
    >
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
        <h2
          id={headingId}
          className="flex items-center gap-2 jts-overline text-ink-muted"
        >
          <ScrollText aria-hidden="true" className="size-4 shrink-0" />
          Everything written, newest first
          <span className="font-bold tabular-nums opacity-70">{total}</span>
        </h2>
        <JtsLiveIndicator
          active={isRefreshing}
          label="This list refreshes itself every few seconds."
        />
      </div>

      {error ? (
        <p role="alert" className="px-4 py-6 text-sm text-danger">
          {error}
        </p>
      ) : null}

      {loading && items.length === 0 ? (
        <p role="status" className="px-4 py-6 text-sm text-ink-muted">
          Loading the outbound history…
        </p>
      ) : null}

      {!loading && !error && items.length === 0 ? (
        <div className="flex flex-col items-center px-4 py-8 text-center">
          <Inbox
            aria-hidden="true"
            className="mb-2 size-7 text-ink-subtle"
            strokeWidth={1.5}
          />
          <p className="text-sm font-semibold text-ink">Nothing sent yet</p>
          <p className="mt-1 text-sm text-ink-muted">
            No outbound feedback message has ever been written.
          </p>
        </div>
      ) : null}

      {items.length > 0 ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <ul>
            {items.map((item) => {
              const isSelected = item.id === selectedId;

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
                      "block w-full cursor-pointer px-4 py-2.5 text-left transition-colors",
                      isSelected
                        ? "bg-primary-soft"
                        : "hover:bg-surface-sunken",
                    )}
                  >
                    <span className="flex items-baseline justify-between gap-3">
                      <span
                        className={clsx(
                          "line-clamp-2 min-w-0 flex-1 text-sm leading-snug font-bold break-words",
                          isSelected ? "text-primary" : "text-ink",
                        )}
                      >
                        <ParticipantName
                          displayName={item.respondentDisplayName}
                        />
                      </span>
                      <span className="shrink-0 text-xs tabular-nums text-ink-muted">
                        {formatTimestamp(item.createdAt)}
                      </span>
                    </span>

                    <span className="mt-1 flex items-center gap-1.5 text-xs text-ink-muted">
                      <span className="shrink-0 font-semibold">
                        {/* The log's one-word answer to «why», ahead of the
                            mechanical kind: «Reminder» repeats the kind, but
                            «Fallback acknowledgement» on a reply row is the
                            fact an operator opens the row to learn. */}
                        {item.origin === null
                          ? outboxKindLabel(item.kind)
                          : outboundOriginLabel(item.origin)}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span className="min-w-0 truncate">
                        {item.eventTitle}
                      </span>
                      {item.phoneAtLaunch === null ? null : (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="shrink-0 tabular-nums">
                            {item.phoneAtLaunch}
                          </span>
                        </>
                      )}
                    </span>

                    <FeedbackBadges
                      badges={[outboxHistoryStatusBadge(item.status)]}
                      className="mt-1.5 flex flex-wrap items-center gap-1.5"
                    />
                  </button>
                </li>
              );
            })}
          </ul>

          {truncated ? (
            <p className="border-t border-border-subtle bg-surface-sunken px-4 py-2.5 text-xs text-ink-muted">
              Showing the {items.length} newest of {total}.
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
