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
  type OutboxHistoryRangeKey,
} from "../features/feedback/outboxQueue";
import {
  OUTBOX_HISTORY_POLL_INTERVAL_MS,
  OUTBOX_MESSAGE_POLL_INTERVAL_MS,
  OUTBOX_QUEUE_POLL_INTERVAL_MS,
} from "../features/feedback/polling";
import { apiErrorMessage } from "../lib/api";
import { usePageMeta } from "../lib/usePageMeta";

/**
 * What has been sent to participants, and what is still waiting.
 *
 * The screen exists because a rehearsal on 2026-07-27 left replies unsent for
 * up to 147 seconds while extraction held every worker slot, and the only way
 * to see it was a hand-written script against Redis. Bull Board speaks in job
 * ids behind its own basic auth; this speaks in conversations and people.
 *
 * **The history is the front door.** The queue answers «is anything stuck right
 * now», which is a question with a healthy answer of «no» — so on a good day it
 * is an empty list, and an empty list is a poor landing page for the screen
 * people actually come here to read. The queue's count rides on its own tab
 * instead, where it can raise its hand without taking the room.
 *
 * **The page never touches Redis.** Both list endpoints derive every field from
 * PostgreSQL plus one batched conversation read, and the opened-row detail is
 * PostgreSQL-only too. Turning an observability page into a queue-inspection
 * loop would be a fairly committed way to recreate the outage it observes.
 *
 * Nothing here is a live region. Every age changes on every poll by
 * construction, so a polite announcement would fire forever and drown the
 * screen; the live indicators carry a hidden sentence saying the panes refresh
 * themselves, and failures still announce through `role="alert"`.
 */
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

  const range: OutboxHistoryRangeKey = isOutboxHistoryRangeKey(
    searchParams.get("range"),
  )
    ? (searchParams.get("range") as OutboxHistoryRangeKey)
    : "all";
  const statusParam = searchParams.get("status");
  const status = isOutboxHistoryStatus(statusParam) ? statusParam : undefined;

  /**
   * Where the operator is in the log, as a stack of cursors.
   *
   * It is a stack rather than a page number because keyset paging only knows
   * how to go forward: the cursor for page 3 is a fact about page 2, so «back»
   * means «forget the last one you were given». Deliberately component state
   * and not a URL parameter — a link that says «this range, this status» stays
   * meaningful tomorrow, and one that also pins page 4 of a log that has grown
   * since does not.
   */
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

  const queueItems = useMemo(
    () => queueQuery.data?.items ?? [],
    [queueQuery.data?.items],
  );
  const historyItems = useMemo(
    () => historyQuery.data?.items ?? [],
    [historyQuery.data?.items],
  );
  const summary = queueQuery.data ? outboxQueueSummary(queueQuery.data) : null;

  const requestedId = searchParams.get("message");
  /**
   * In the queue, a selection lasts exactly as long as the wait it is about: a
   * message that reached the participant between two polls should stop being
   * the thing on screen rather than pin a pane describing a wait that is over.
   *
   * In the history nothing falls away — that is the point of the half — and
   * that now includes paging. The opened row is fetched by id and knows nothing
   * about pages, so walking back through the log while keeping one message on
   * screen is exactly the comparison an operator paged for.
   */
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

  /**
   * Any change to *which* rows exist restarts the walk through them.
   *
   * A cursor is a position inside one filtered set. Carrying it across a filter
   * change would ask the server to continue from a row that may not be in the
   * new set at all, and the honest answer to that is a page nobody asked for.
   */
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
          description="Everything the bot or an operator has written to a participant. The queue is dispatch that remains unresolved or deliberately held; age is the number that matters there."
        />

        {/* The queue's three figures, as one line rather than three cards.
            Stacked cards cost about a fifth of a laptop screen for numbers that
            are single digits on a healthy day — and the height they took came
            straight out of the two panes doing the actual work. */}
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
        <div
          role="group"
          aria-label="History or queue"
          className="flex w-fit items-center gap-1 rounded-md border border-border bg-surface p-1"
        >
          {(
            [
              ["history", "History", null],
              ["queue", "Queue", summary?.total ?? null],
            ] as const
          ).map(([value, label, count]) => (
            <button
              key={value}
              type="button"
              aria-pressed={view === value}
              onClick={() => selectView(value)}
              className={clsx(
                "flex cursor-pointer items-center gap-2 rounded-sm px-3 py-1 text-sm font-semibold transition-colors",
                view === value
                  ? "bg-primary-soft text-primary"
                  : "text-ink-muted hover:text-ink",
              )}
            >
              {label}
              {/* The backlog follows its own tab, so leaving the queue does not
                  mean losing sight of it. Zero is drawn quietly rather than
                  hidden: a badge that vanishes teaches nothing, while «0»
                  states that the question was asked and answered. */}
              {count === null ? null : (
                <span
                  className={clsx(
                    "rounded-full px-1.5 py-px text-xs font-bold tabular-nums",
                    count === 0
                      ? "bg-surface-sunken text-ink-subtle"
                      : "bg-warning-soft text-warning",
                  )}
                >
                  <span aria-hidden="true">{count}</span>
                  <span className="sr-only">
                    {count === 1 ? "1 message" : `${count} messages`} waiting
                  </span>
                </span>
              )}
            </button>
          ))}
        </div>

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
        {/* Narrow list, wide detail — the opposite of the first cut, and the
            way round the work runs: a row is one name and one time, while the
            thing an operator opened it for is a message, a decision and a
            timeline. Two columns from `lg`, not `2xl`: a 1440px laptop never
            reached `2xl`, so the pane that was meant to sit beside the list
            spent a year underneath it. */}
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

/** One figure of the queue strip: a glyph, a micro-caps label and a number. */
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
    <div className="flex min-w-[6.5rem] items-center gap-2.5 px-4 py-2.5">
      <Icon
        aria-hidden="true"
        className={clsx(
          "size-4 shrink-0",
          urgent ? "text-warning" : "text-ink-subtle",
        )}
      />
      <div className="min-w-0">
        <dt className="m-0 jts-overline text-ink-muted">{label}</dt>
        <dd
          className={clsx(
            "m-0 text-lg leading-tight font-extrabold tabular-nums",
            urgent ? "text-warning" : "text-ink",
          )}
        >
          {value}
        </dd>
      </div>
    </div>
  );
}
