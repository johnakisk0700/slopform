import { ArrowLeft, Hourglass, Pause, SendHorizontal } from "lucide-react";
import { useMemo } from "react";
import { Link, useSearchParams } from "react-router";

import {
  useGetFeedbackOutboxMessage,
  useListFeedbackOutboxQueue,
} from "../api/generated/feedback-outbox";
import {
  OutboxMessageDetails,
  OutboxMessageDetailsEmpty,
} from "../components/admin/feedback/OutboxMessageDetails";
import { OutboxQueueList } from "../components/admin/feedback/OutboxQueueList";
import { JtsPageHeader } from "../components/ui/JtsPageHeader";
import { JtsStat } from "../components/ui/JtsStat";
import {
  formatWaiting,
  outboxQueueSummary,
} from "../features/feedback/outboxQueue";
import {
  OUTBOX_MESSAGE_POLL_INTERVAL_MS,
  OUTBOX_QUEUE_POLL_INTERVAL_MS,
} from "../features/feedback/polling";
import { apiErrorMessage } from "../lib/api";
import { usePageMeta } from "../lib/usePageMeta";

/**
 * What is queued for participants, how long it has waited, and what the
 * delivery attempts are doing.
 *
 * The screen exists because a rehearsal on 2026-07-27 left replies unsent for
 * up to 147 seconds while extraction held every worker slot, and the only way
 * to see it was a hand-written script against Redis. Bull Board speaks in job
 * ids behind its own basic auth; this speaks in conversations and people.
 *
 * **The list never touches Redis.** `listFeedbackOutboxQueue` is polled every
 * five seconds and derives every field, ages included, from PostgreSQL plus one
 * batched conversation read. The queue is consulted exactly once per opened
 * row, by `getFeedbackOutboxMessage` — a page that opened a Redis connection
 * per row would become the outage it was built to observe.
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
    "Outbound feedback messages that have not reached the participant, with their age and delivery job state.",
  );

  const queueQuery = useListFeedbackOutboxQueue({
    query: {
      refetchInterval: OUTBOX_QUEUE_POLL_INTERVAL_MS,
      refetchOnWindowFocus: true,
    },
  });

  const items = useMemo(
    () => queueQuery.data?.items ?? [],
    [queueQuery.data?.items],
  );
  const summary = queueQuery.data ? outboxQueueSummary(queueQuery.data) : null;

  const requestedId = searchParams.get("message");
  // Selection survives a poll while the row is still waiting, and falls away
  // once it is not — a message that reached the participant should stop being
  // the thing on screen.
  const selectedId =
    requestedId !== null && items.some((item) => item.id === requestedId)
      ? requestedId
      : null;

  function selectMessage(outboxId: string) {
    const next = new URLSearchParams(searchParams);
    next.set("message", outboxId);
    setSearchParams(next, { replace: true });
  }

  const messageQuery = useGetFeedbackOutboxMessage(selectedId ?? "", {
    query: {
      enabled: selectedId !== null,
      refetchInterval: OUTBOX_MESSAGE_POLL_INTERVAL_MS,
      refetchOnWindowFocus: true,
    },
  });

  return (
    <div className="flex flex-col gap-5">
      <p>
        <Link
          to="/admin/feedback"
          className="inline-flex items-center gap-1.5 text-sm font-semibold text-primary no-underline underline-offset-2 hover:underline"
        >
          <ArrowLeft aria-hidden="true" className="size-4 shrink-0" />
          All campaigns
        </Link>
      </p>

      <JtsPageHeader
        eyebrow="Post-event feedback"
        title="Outbound queue"
        description="Messages the bot or an operator has written that the participant does not have yet. Age is the number that matters: a few seconds is normal, minutes mean delivery is behind."
      />

      {summary ? (
        <dl className="m-0 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {/* No tone on the count. A backlog of six is not good or bad by
              itself — the age beside it is what says whether anything is
              wrong, and toning both would state it twice, once wrongly. */}
          <JtsStat
            label="Waiting"
            value={summary.total}
            detail={
              summary.total === 0
                ? "Nothing is queued"
                : `${summary.pending} queued · ${summary.sending} sending · ${summary.held} held`
            }
            icon={SendHorizontal}
          />
          <JtsStat
            label="Oldest"
            value={
              summary.oldestWaitingSeconds === null
                ? "—"
                : formatWaiting(summary.oldestWaitingSeconds)
            }
            detail={
              summary.oldestWaitingSeconds === null
                ? "No message is waiting"
                : "Measured on the server, refreshed every 5 seconds"
            }
            icon={Hourglass}
            {...(summary.worstTone === "stalled" || summary.worstTone === "slow"
              ? { tone: "warning" as const }
              : {})}
          />
          <JtsStat
            label="Held back"
            value={summary.held}
            detail="Held rows are never handed to the relay"
            icon={Pause}
          />
        </dl>
      ) : null}

      <div className="grid items-start gap-4 2xl:grid-cols-[minmax(0,1fr)_minmax(20rem,26rem)]">
        <OutboxQueueList
          items={items}
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

        <div className="min-h-0">
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
              Reading this message&rsquo;s delivery job…
            </p>
          ) : (
            <OutboxMessageDetailsEmpty />
          )}
        </div>
      </div>
    </div>
  );
}
