import type { FeedbackConversationDocument } from "./post-event-feedback-conversation.document.js";

/**
 * The newest participant timestamp is found by scanning rather than by taking
 * the last message: transcript order follows arrival, and a webhook can be
 * delivered out of order.
 */
export function latestParticipantMessage(
  conversation: FeedbackConversationDocument,
): FeedbackConversationDocument["messages"][number] | undefined {
  let latest: FeedbackConversationDocument["messages"][number] | undefined;
  for (const message of conversation.messages) {
    if (
      message.actor === "participant" &&
      (latest === undefined || message.at > latest.at)
    ) {
      latest = message;
    }
  }
  return latest;
}
