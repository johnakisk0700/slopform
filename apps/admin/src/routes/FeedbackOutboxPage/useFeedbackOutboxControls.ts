import { useCallback, useMemo, useState } from "react";
import { useSearchParams } from "react-router";

import {
  useGetFeedbackOutboxMessage,
  useListFeedbackOutboxHistory,
  useListFeedbackOutboxQueue,
} from "../../api/generated/feedback-outbox";
import {
  isOutboxHistoryRangeKey,
  isOutboxHistoryStatus,
  outboxHistoryRangeFrom,
  outboxQueueSummary,
} from "../../features/feedback/outboxQueue";
import {
  OUTBOX_HISTORY_POLL_INTERVAL_MS,
  OUTBOX_MESSAGE_POLL_INTERVAL_MS,
  OUTBOX_QUEUE_POLL_INTERVAL_MS,
} from "../../features/feedback/polling";

export function useFeedbackOutboxControls() {
  const [searchParams, setSearchParams] = useSearchParams();

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
  return {
    view,
    range,
    status,
    setCursors,
    atNewest,
    queueQuery,
    historyQuery,
    queueItems,
    historyItems,
    summary,
    selectedId,
    selectMessage,
    selectView,
    changeFilter,
    nextCursor,
    messageQuery,
  };
}
