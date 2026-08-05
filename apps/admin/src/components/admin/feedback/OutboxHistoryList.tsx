import { Button } from "@heroui/react";
import { clsx } from "clsx";
import {
  ArrowUpToLine,
  ChevronLeft,
  ChevronRight,
  Inbox,
  ScrollText,
} from "lucide-react";
import { useId } from "react";

import type { FeedbackOutboxHistoryDtoOutputItemsItem } from "../../../api/generated/model/feedbackOutboxHistoryDtoOutputItemsItem";
import { formatPreciseTimestamp } from "../../../features/feedback/conversationView";
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
  /** Rows matching the active filter — not rows in the table. */
  total: number;
  isRefreshing: boolean;
  /** True on the first page, which is the only one that refreshes itself. */
  atNewest: boolean;
  hasOlder: boolean;
  onOlder: () => void;
  onNewer: () => void;
  onNewest: () => void;
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
 * It is a narrow column beside a wide detail pane, so a row is written for
 * scanning rather than reading: a name, a time, and the one word that says why
 * the message exists. Everything else about it is one click away, in a pane
 * with room for it.
 *
 * Same restraint as the queue list: no live region (rows arrive on every
 * poll), one `aria-current` selection, and opening a row is what spends the
 * single opened-row detail read. Both the list and detail are PostgreSQL-only.
 */
export function OutboxHistoryList({
  items,
  selectedId,
  onSelect,
  loading,
  error,
  total,
  isRefreshing,
  atNewest,
  hasOlder,
  onOlder,
  onNewer,
  onNewest,
}: OutboxHistoryListProps) {
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
          <ScrollText aria-hidden="true" className="size-4 shrink-0" />
          <span className="truncate">Newest first</span>
          <span className="shrink-0 font-bold tabular-nums opacity-70">
            {total}
          </span>
        </h2>
        {/* Only the newest page is live. Further back, the indicator would
            claim a refresh that deliberately is not happening. */}
        {atNewest ? (
          <JtsLiveIndicator
            active={isRefreshing}
            label="This list refreshes itself every few seconds while you are on the newest page."
          />
        ) : null}
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
          <p className="text-sm font-semibold text-ink">Nothing here</p>
          <p className="mt-1 text-sm text-ink-muted">
            {/* A filter that matches nothing is not the same fact as a table
                that holds nothing, and telling an operator the second when the
                first is true sends them looking for a bug. */}
            {total === 0
              ? "No outbound feedback message matches this range and status."
              : "This page of the log is empty."}
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
                      {/* To the millisecond, because this list is where two
                          decisions get compared: «67 seconds apart» is a
                          different story from «the same minute», and the
                          minute is what used to be printed here. No pill —
                          fifty of them would be more chrome than list. */}
                      <span className="shrink-0 text-xs tabular-nums text-ink-muted">
                        {formatPreciseTimestamp(item.createdAt)}
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
                      {/* The event title, not the phone number: the column is
                          half the width it was, and a number nobody dials from
                          here was the first thing worth its space. It is on
                          the opened row, beside the conversation it belongs
                          to. */}
                      <span className="min-w-0 truncate">
                        {item.eventTitle}
                      </span>
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
        </div>
      ) : null}

      {/* The walk through the log. Keyset paging only knows how to go forward,
          so there is no page number to print and none is invented: «Older» and
          «Newer» are exactly the two moves the cursor supports, and «Newest»
          is the way back to the page that keeps itself up to date. */}
      {items.length > 0 || !atNewest ? (
        <nav
          aria-label="History pages"
          className="flex items-center justify-between gap-2 border-t border-border-subtle bg-surface-sunken px-3 py-2"
        >
          <div className="flex items-center gap-1">
            <PageButton
              onClick={onNewer}
              disabled={atNewest}
              icon={ChevronLeft}
              label="Newer"
            />
            <PageButton
              onClick={onOlder}
              disabled={!hasOlder}
              icon={ChevronRight}
              label="Older"
              iconTrailing
            />
          </div>

          {atNewest ? (
            <span className="text-xs text-ink-subtle">Newest page</span>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              onPress={onNewest}
              className="h-auto min-h-0 gap-1.5 px-0 py-0 text-xs font-semibold text-primary underline-offset-2 hover:bg-transparent hover:underline data-[hovered=true]:bg-transparent"
            >
              <ArrowUpToLine aria-hidden="true" className="size-3.5" />
              Jump to newest
            </Button>
          )}
        </nav>
      ) : null}
    </section>
  );
}

/** One move along the log, disabled at the end it cannot go past. */
function PageButton({
  onClick,
  disabled,
  icon: Icon,
  label,
  iconTrailing = false,
}: {
  onClick: () => void;
  disabled: boolean;
  icon: typeof ChevronLeft;
  label: string;
  iconTrailing?: boolean;
}) {
  const glyph = <Icon aria-hidden="true" className="size-3.5 shrink-0" />;

  return (
    <Button
      variant="secondary"
      size="sm"
      onPress={onClick}
      isDisabled={disabled}
      className="h-auto min-h-0 gap-1 px-2 py-1 text-xs font-semibold"
    >
      {iconTrailing ? null : glyph}
      {label}
      {iconTrailing ? glyph : null}
    </Button>
  );
}
