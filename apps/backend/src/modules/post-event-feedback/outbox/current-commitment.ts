import type { FeedbackConversationDocument } from "../post-event-feedback-conversation.document.js";

/**
 * Exact participant-facing promise that may still be sent after extraction
 * hands the conversation to a human.
 *
 * A later participant fragment does not revoke that promise. Safety-only runs,
 * however, add no post-cursor bot turn, so an older queued reply receives no
 * accidental exemption.
 */
export function currentAwaitingHumanCommitmentOutboxId(
  conversation: FeedbackConversationDocument,
): string | null {
  if (!conversation.awaitingHuman) return null;

  const latestBotMessage = conversation.messages.reduce<
    FeedbackConversationDocument["messages"][number] | undefined
  >(
    (latest, message) =>
      message.actor === "bot" &&
      (latest === undefined || message.seq > latest.seq)
        ? message
        : latest,
    undefined,
  );

  return latestBotMessage &&
    latestBotMessage.seq > conversation.extraction.cursorSeq
    ? latestBotMessage.outboxId
    : null;
}

export function isCurrentAwaitingHumanCommitment(
  outboxId: string,
  conversation: FeedbackConversationDocument,
): boolean {
  return currentAwaitingHumanCommitmentOutboxId(conversation) === outboxId;
}
