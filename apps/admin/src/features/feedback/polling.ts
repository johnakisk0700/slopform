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
export const CONVERSATION_POLL_INTERVAL_MS = 3_000;

/** The inbox list: slower, because it only changes on arrival or lifecycle. */
export const CONVERSATION_LIST_POLL_INTERVAL_MS = 10_000;

/** Answers and notes: extraction lands after the message, so this can lag. */
export const RESULTS_POLL_INTERVAL_MS = 15_000;

/**
 * Stops polling a conversation that can no longer change. A closed thread
 * under bot control has no pending transition left to observe, so holding a
 * 3-second timer on it is pure noise.
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
