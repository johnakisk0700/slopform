import {
  ListBox,
  Select,
  ToggleButton,
  ToggleButtonGroup,
} from "@heroui/react";
import { CalendarRange, Filter } from "lucide-react";

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

/** Matches `FeedbackCampaignsPage` / `AdminUserMenu` segmented chips. */
const CHOICE_CHIP =
  "justify-center rounded-md border border-border bg-transparent px-2.5 text-xs font-semibold text-ink " +
  "data-[selected]:border-primary-border data-[selected]:bg-primary-soft data-[selected]:text-primary";

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
 * The range is a HeroUI segmented group and the status a Select: four options
 * that are one scale read best side by side, while seven unordered ones would
 * be a wall of chips wider than the list they filter.
 */
export function OutboxHistoryToolbar({
  range,
  status,
  onRangeChange,
  onStatusChange,
}: OutboxHistoryToolbarProps) {
  return (
    <div className="flex flex-wrap items-center gap-5">
      <div className="flex items-center gap-1.5">
        <CalendarRange
          aria-hidden="true"
          className="size-3.5 shrink-0 text-ink-subtle"
        />
        <ToggleButtonGroup
          aria-label="How far back"
          selectionMode="single"
          disallowEmptySelection
          isDetached
          selectedKeys={[range]}
          onSelectionChange={(keys) => {
            const [next] = keys;
            if (
              next === "hour" ||
              next === "today" ||
              next === "week" ||
              next === "all"
            ) {
              onRangeChange(next);
            }
          }}
        >
          {OUTBOX_HISTORY_RANGES.map((option) => (
            <ToggleButton
              key={option.key}
              id={option.key}
              size="sm"
              className={CHOICE_CHIP}
            >
              {option.label}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
      </div>

      <div className="flex items-center gap-1.5">
        <Filter
          aria-hidden="true"
          className="size-3.5 shrink-0 text-ink-subtle"
        />
        <Select
          aria-label="Filter by status"
          selectedKey={status}
          onSelectionChange={(key) => {
            const next = String(key ?? "any");
            const match = OUTBOX_HISTORY_STATUS_FILTERS.find(
              (option) => option.key === next,
            );
            if (match) {
              onStatusChange(match.key);
            }
          }}
        >
          <Select.Trigger className="min-h-8 min-w-[9rem] rounded-md border border-border bg-transparent px-2.5 text-xs font-semibold text-ink shadow-none">
            <Select.Value />
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover>
            <ListBox>
              {OUTBOX_HISTORY_STATUS_FILTERS.map((option) => (
                <ListBox.Item
                  key={option.key}
                  id={option.key}
                  textValue={option.label}
                >
                  {option.label}
                </ListBox.Item>
              ))}
            </ListBox>
          </Select.Popover>
        </Select>
      </div>
    </div>
  );
}
