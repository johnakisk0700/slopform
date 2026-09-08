import { ToggleButton, ToggleButtonGroup } from "@heroui/react";
import { clsx } from "clsx";
import { Hourglass, Pause, SendHorizontal } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { useSearchParams } from "react-router";

import {
  useGetFeedbackOutboxMessage,
  useListFeedbackOutboxHistory,
  useListFeedbackOutboxQueue,
} from "../api/generated/feedback-outbox";
import { OutboxHistoryList } from "../components/admin/feedback/OutboxHistoryList";
import { OutboxHistoryToolbar } from "../components/admin/feedback/OutboxHistoryToolbar";
import {
  OutboxMessageDetails,
  OutboxMessageDetailsEmpty,
} from "../components/admin/feedback/OutboxMessageDetails";
import { OutboxQueueList } from "../components/admin/feedback/OutboxQueueList";
import { JtsPageHeader } from "../components/ui/JtsPageHeader";
import {
  formatWaiting,
  isOutboxHistoryRangeKey,
  isOutboxHistoryStatus,
  outboxHistoryRangeFrom,
  outboxQueueSummary,
} from "../features/feedback/outboxQueue";
import {
  OUTBOX_HISTORY_POLL_INTERVAL_MS,
  OUTBOX_MESSAGE_POLL_INTERVAL_MS,
  OUTBOX_QUEUE_POLL_INTERVAL_MS,
} from "../features/feedback/polling";
import { apiErrorMessage } from "../lib/api";
import { usePageMeta } from "../lib/usePageMeta";

/** Read-only history and waiting queue. Polling ages are deliberately not live regions. */
export function FeedbackOutboxPage() {
  const [searchParams, setSearchParams] = useSearchParams();

  usePageMeta(
    "Outbound queue",
    "Every outbound feedback message, what happened to it, and any dispatch still unresolved or deliberately held.",
  );

  // The two halves of the screen: the history is «everything ever written, and
  // why», the queue is «who is waiting right now». History is the default
  // because it is the one that still has something to say on a good day.
  const view = searchParams.get("view") === "queue" ? "queue" : "history";

  const rangeParam = searchParams.get("range");
  const range = isOutboxHistoryRangeKey(rangeParam) ? rangeParam : "all";
  const statusParam = searchParams.get("status");
  const status = isOutboxHistoryStatus(statusParam) ? statusParam : undefined;

  // Keyset paging needs a cursor stack for Back. Keep positions out of shareable URLs.
  const [cursors, setCursors] = useState<string[]>([]);
  const cursor = cursors.at(-1);
  const atNewest = cursor === undefined;

  const from = useMemo(() => outboxHistoryRangeFrom(range), [range]);

  const queueQuery = useListFeedbackOutboxQueue({
    query: {
      // Polled in both views: the count on the Queue tab is the only thing
      // telling a reader of the history that something is stuck behind them.
      refetchInterval: OUTBOX_QUEUE_POLL_INTERVAL_MS,
      refetchOnWindowFocus: true,
    },
  });
  const historyQuery = useListFeedbackOutboxHistory(
    {
      ...(cursor === undefined ? {} : { cursor }),
      ...(status === undefined ? {} : { status }),
      ...(from === undefined ? {} : { from }),
    },
    {
      query: {
        enabled: view === "history",
        // **Only the newest page refreshes itself.** Once an operator has
        // walked back into the log, new rows land above where they are reading;
        // re-fetching would either move the page under them or spend a request
        // proving that an older, finished slice has not changed.
        ...(atNewest
          ? { refetchInterval: OUTBOX_HISTORY_POLL_INTERVAL_MS }
          : {}),
        refetchOnWindowFocus: atNewest,
        // The previous page stays on screen while the next one loads, so the
        // list never blinks to an empty state between two clicks of «Older».
        placeholderData: (previous) => previous,
      },
    },
  );

  const queueItems = queueQuery.data?.items ?? [];
  const historyItems = historyQuery.data?.items ?? [];
  const summary = queueQuery.data ? outboxQueueSummary(queueQuery.data) : null;

  const requestedId = searchParams.get("message");
  // Queue selections expire with the wait; history selections survive page changes.
  const selectedId =
    requestedId === null
      ? null
      : view === "history" || queueItems.some((item) => item.id === requestedId)
        ? requestedId
        : null;

  function selectMessage(outboxId: string) {
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.set("message", outboxId);
        return next;
      },
      { replace: true },
    );
  }

  function selectView(nextView: "queue" | "history") {
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (nextView === "queue") {
          next.set("view", "queue");
        } else {
          next.delete("view");
        }
        return next;
      },
      // A row keeps meaning the same thing in both views, so the selection
      // stays; only the list under it changes.
      { replace: true },
    );
  }

  // A cursor belongs to one filtered set, so filter changes return to its newest page.
  const changeFilter = useCallback(
    (key: "range" | "status", value: string | null) => {
      setCursors([]);
      // Built from the *current* params rather than the ones this render
      // closed over: two filters changed inside one tick would otherwise have
      // the second write undo the first, putting back a range the operator had
      // just cleared.
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current);
          if (value === null) {
            next.delete(key);
          } else {
            next.set(key, value);
          }
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const nextCursor = historyQuery.data?.nextCursor ?? null;

  const messageQuery = useGetFeedbackOutboxMessage(selectedId ?? "", {
    query: {
      enabled: selectedId !== null,
      refetchInterval: OUTBOX_MESSAGE_POLL_INTERVAL_MS,
      refetchOnWindowFocus: true,
    },
  });

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <JtsPageHeader
          back={{ to: "/admin/feedback", label: "Back to campaigns" }}
          eyebrow="Post-event feedback"
          title="Outbound queue"
          description="Every word this system has put in front of a participant. What is still queued is either unresolved or deliberately held — and how long it has waited is the number that matters."
        />

        <dl className="m-0 flex shrink-0 items-stretch divide-x divide-border-subtle rounded-md border border-border bg-surface">
          <QueueFigure
            icon={SendHorizontal}
            label="Waiting"
            value={summary === null ? "—" : summary.total}
          />
          <QueueFigure
            icon={Hourglass}
            label="Oldest"
            value={
              summary === null || summary.oldestWaitingSeconds === null
                ? "—"
                : formatWaiting(summary.oldestWaitingSeconds)
            }
            // The count carries no tone — a backlog of six is neither good nor
            // bad — but the age beside it is what says whether it is either.
            urgent={
              summary?.worstTone === "stalled" || summary?.worstTone === "slow"
            }
          />
          <QueueFigure
            icon={Pause}
            label="Held"
            value={summary === null ? "—" : summary.held}
          />
        </dl>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <ToggleButtonGroup
          aria-label="History or queue"
          selectionMode="single"
          disallowEmptySelection
          isDetached
          selectedKeys={[view]}
          onSelectionChange={(keys) => {
            const [next] = keys;
            if (next === "history" || next === "queue") {
              selectView(next);
            }
          }}
        >
          <ToggleButton
            id="history"
            size="sm"
            className="justify-center gap-2 rounded-md border border-border bg-transparent px-3 text-sm font-semibold text-ink data-[selected]:border-primary-border data-[selected]:bg-primary-soft data-[selected]:text-primary"
          >
            History
          </ToggleButton>
          <ToggleButton
            id="queue"
            size="sm"
            className="justify-center gap-2 rounded-md border border-border bg-transparent px-3 text-sm font-semibold text-ink data-[selected]:border-primary-border data-[selected]:bg-primary-soft data-[selected]:text-primary"
          >
            Queue
            {/* The backlog follows its own tab, so leaving the queue does not
                mean losing sight of it. Zero is drawn quietly rather than
                hidden: a badge that vanishes teaches nothing, while «0»
                states that the question was asked and answered. */}
            <span
              className={clsx(
                "rounded-full px-1.5 py-px text-xs font-bold tabular-nums",
                (summary?.total ?? 0) === 0
                  ? "bg-surface-sunken text-ink-subtle"
                  : "bg-warning-soft text-warning",
              )}
            >
              <span aria-hidden="true">{summary?.total ?? 0}</span>
              <span className="sr-only">
                {(summary?.total ?? 0) === 1
                  ? "1 message"
                  : `${summary?.total ?? 0} messages`}{" "}
                waiting
              </span>
            </span>
          </ToggleButton>
        </ToggleButtonGroup>

        {view === "history" ? (
          <OutboxHistoryToolbar
            range={range}
            status={status ?? "any"}
            onRangeChange={(next) =>
              changeFilter("range", next === "all" ? null : next)
            }
            onStatusChange={(next) =>
              changeFilter("status", next === "any" ? null : next)
            }
          />
        ) : null}
      </div>

      <div className="grid min-h-0 flex-1 items-stretch gap-4 lg:grid-cols-[minmax(18rem,22rem)_minmax(0,1fr)]">
        {view === "queue" ? (
          <OutboxQueueList
            items={queueItems}
            selectedId={selectedId}
            onSelect={selectMessage}
            loading={queueQuery.isPending}
            error={
              queueQuery.isError
                ? apiErrorMessage(
                    queueQuery.error,
                    "Failed to load the outbound queue.",
                  )
                : null
            }
            truncated={queueQuery.data?.truncated ?? false}
            total={summary?.total ?? 0}
            isRefreshing={queueQuery.isFetching}
          />
        ) : (
          <OutboxHistoryList
            items={historyItems}
            selectedId={selectedId}
            onSelect={selectMessage}
            loading={historyQuery.isPending}
            error={
              historyQuery.isError
                ? apiErrorMessage(
                    historyQuery.error,
                    "Failed to load the outbound history.",
                  )
                : null
            }
            total={historyQuery.data?.total ?? 0}
            isRefreshing={historyQuery.isFetching}
            atNewest={atNewest}
            hasOlder={nextCursor !== null}
            onOlder={() => {
              if (nextCursor !== null) {
                setCursors((stack) => [...stack, nextCursor]);
              }
            }}
            onNewer={() => setCursors((stack) => stack.slice(0, -1))}
            onNewest={() => setCursors([])}
          />
        )}

        <div className="flex min-h-0 flex-col">
          {messageQuery.data && selectedId !== null ? (
            <OutboxMessageDetails
              message={messageQuery.data}
              isRefreshing={messageQuery.isFetching}
            />
          ) : messageQuery.isError ? (
            <p role="alert" className="text-sm text-danger">
              {apiErrorMessage(
                messageQuery.error,
                "Failed to load this message.",
              )}
            </p>
          ) : messageQuery.isPending && selectedId !== null ? (
            <p role="status" className="text-sm text-ink-muted">
              Reading this message&rsquo;s dispatch record…
            </p>
          ) : (
            <OutboxMessageDetailsEmpty />
          )}
        </div>
      </div>
    </div>
  );
}

/** One figure of the queue strip: micro-caps label, then glyph + number. */
function QueueFigure({
  icon: Icon,
  label,
  value,
  urgent = false,
}: {
  icon: typeof SendHorizontal;
  label: string;
  value: string | number;
  urgent?: boolean;
}) {
  return (
    <div className="flex min-w-[6.5rem] flex-col gap-1 px-4 py-2.5">
      <dt className="m-0 jts-overline text-ink-muted">{label}</dt>
      <dd
        className={clsx(
          "m-0 flex items-center gap-2 text-lg leading-none font-extrabold tabular-nums",
          urgent ? "text-warning" : "text-ink",
        )}
      >
        <Icon
          aria-hidden="true"
          className={clsx(
            "size-4 shrink-0",
            urgent ? "text-warning" : "text-ink-subtle",
          )}
        />
        <span>{value}</span>
      </dd>
    </div>
  );
}
