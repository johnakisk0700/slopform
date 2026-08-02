import { clsx } from "clsx";
import { CalendarRange, Filter } from "lucide-react";
import { useId } from "react";

import type { FeedbackOutboxHistoryDtoOutputItemsItemStatus } from "../../../api/generated/model/feedbackOutboxHistoryDtoOutputItemsItemStatus";
import {
  OUTBOX_HISTORY_RANGES,
  OUTBOX_HISTORY_STATUS_FILTERS,
  type OutboxHistoryRangeKey,
} from "../../../features/feedback/outboxQueue";

export type OutboxHistoryStatusFilter =
  FeedbackOutboxHistoryDtoOutputItemsItemStatus | "any";

interface OutboxHistoryToolbarProps {
  range: OutboxHistoryRangeKey;
  status: OutboxHistoryStatusFilter;
  onRangeChange: (range: OutboxHistoryRangeKey) => void;
  onStatusChange: (status: OutboxHistoryStatusFilter) => void;
}

/**
 * How far back the history reaches, and which rows of it count.
 *
 * `message_outbox` is append-only and nothing prunes it, so this list is a log
 * and every question anybody brings to a log is a narrowing one: what broke in
 * the last hour, what did we send today, show me only the failures. Paging
 * alone answers none of those — «the failure was somewhere in the last four
 * thousand rows» is not an answer, it is the same problem with a button.
 *
 * Two controls and no date pickers. The ranges are the questions people
 * actually ask, and a pair of pickers would make the common case cost six
 * interactions; the day a genuine arbitrary range is needed, it belongs here as
 * a third control rather than as the price of the first two.
 *
 * The range is segmented and the status is a `select`: four options that are
 * one scale read best side by side, while seven unordered ones would be a wall
 * of chips wider than the list they filter.
 */
export function OutboxHistoryToolbar({
  range,
  status,
  onRangeChange,
  onStatusChange,
}: OutboxHistoryToolbarProps) {
  const statusId = useId();

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div
        role="group"
        aria-label="How far back"
        className="flex items-center gap-1 rounded-md border border-border bg-surface p-1"
      >
        <CalendarRange
          aria-hidden="true"
          className="ml-1 size-3.5 shrink-0 text-ink-subtle"
        />
        {OUTBOX_HISTORY_RANGES.map((option) => (
          <button
            key={option.key}
            type="button"
            aria-pressed={range === option.key}
            onClick={() => onRangeChange(option.key)}
            className={clsx(
              "cursor-pointer rounded-sm px-2.5 py-1 text-xs font-semibold whitespace-nowrap transition-colors",
              range === option.key
                ? "bg-primary-soft text-primary"
                : "text-ink-muted hover:text-ink",
            )}
          >
            {option.label}
          </button>
        ))}
      </div>

      <div className="flex items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-1">
        <Filter
          aria-hidden="true"
          className="size-3.5 shrink-0 text-ink-subtle"
        />
        <label htmlFor={statusId} className="sr-only">
          Filter by status
        </label>
        <select
          id={statusId}
          value={status}
          onChange={(event) =>
            onStatusChange(event.target.value as OutboxHistoryStatusFilter)
          }
          className="cursor-pointer bg-transparent py-0.5 pr-1 text-xs font-semibold text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          {OUTBOX_HISTORY_STATUS_FILTERS.map((option) => (
            <option key={option.key} value={option.key}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
