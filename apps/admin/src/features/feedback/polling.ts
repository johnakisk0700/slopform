/**
 * Polling policy for the conversations inbox (U3).
 *
 * WebSockets/SSE are deliberately deferred: one operator watching one screen
 * does not justify push infrastructure. TanStack Query's `refetchInterval`
 * carries the load, and because `refetchIntervalInBackground` stays at its
 * default `false`, every interval below pauses on its own while the browser
 * tab is hidden — there is no visibility listener to maintain here.
 */

/** The open conversation: fast enough to feel live in a reply exchange. */
export const CONVERSATION_POLL_INTERVAL_MS = 2_000;

/** The inbox list: slower, because it only changes on arrival or lifecycle. */
export const CONVERSATION_LIST_POLL_INTERVAL_MS = 5_000;

/** Answers and notes: extraction lands after the message, so this can lag. */
export const RESULTS_POLL_INTERVAL_MS = 10_000;

/**
 * Campaign summary while generation is in flight. Matched to the outbox
 * cadence: fast enough to notice ready/failed, slow enough not to thrash.
 */
export const CAMPAIGN_SUMMARY_POLL_INTERVAL_MS = 3_000;

/**
 * The outbound queue list.
 *
 * Three seconds samples the dispatcher's one-second scans without hammering an
 * operator-only GET. It is also the display resolution of every age on that
 * screen: the server measures them, so the interval is how stale the oldest
 * visible value can get.
 */
export const OUTBOX_QUEUE_POLL_INTERVAL_MS = 3_000;

/**
 * One opened outbound message. Its activity block is durable PostgreSQL state,
 * so this cadence is about operator freshness rather than queue inspection.
 */
export const OUTBOX_MESSAGE_POLL_INTERVAL_MS = 3_000;

/**
 * The outbound history list. An archive, not a wait — new rows arrive at the
 * pace conversations move, and nothing on the row ages, so a slower cadence
 * than the queue loses nothing.
 */
export const OUTBOX_HISTORY_POLL_INTERVAL_MS = 5_000;

/**
 * Stops polling a conversation that can no longer change. A closed thread
 * under bot control has no pending transition left to observe, so holding a
 * fast timer on it is pure noise.
 */
export function conversationPollInterval(
  conversation: { lifecycle: { state: "open" | "closed" } } | undefined,
): number | false {
  if (conversation === undefined) {
    return CONVERSATION_POLL_INTERVAL_MS;
  }
  return conversation.lifecycle.state === "open"
    ? CONVERSATION_POLL_INTERVAL_MS
    : false;
}
