import type { FeedbackConversationDocument } from "../post-event-feedback-conversation.document.js";
import { latestParticipantMessage } from "../conversation-reader.js";
import { FEEDBACK_EXTRACT_QUIET_WINDOW_MS } from "../jobs.schemas.js";
import type { FeedbackExtractOutcome } from "../metrics.service.js";

/**
 * Cheap exits from reloaded state (STOP, takeover, or a newer run may have
 * landed while the job waited). Shared by admit and the capacity brake.
 */
export function skipExtractOutcome(
  conversation: FeedbackConversationDocument,
  latestSeq: number,
): FeedbackExtractOutcome | undefined {
  if (conversation.lifecycle.state === "closed") {
    return "skipped_closed";
  }
  if (conversation.control.mode === "human") {
    return "skipped_human_control";
  }
  // `awaitingHuman` is still bot control; the bot must not resume.
  if (conversation.awaitingHuman) {
    return "skipped_awaiting_human";
  }
  if (conversation.extraction.cursorSeq >= latestSeq) {
    return "skipped_cursor";
  }
  if (isExtractStillTyping(conversation)) {
    return "skipped_still_typing";
  }
  return undefined;
}

/**
 * Burst not over: stand down. Defensive for V1/old-binary wakes whose due
 * time can land while the participant is still typing. Newest-message run
 * always proceeds (`>=`); cursor stays put.
 */
function isExtractStillTyping(
  conversation: FeedbackConversationDocument,
): boolean {
  const spokeAt = latestParticipantMessage(conversation)?.at;
  return (
    spokeAt !== undefined &&
    Date.now() - spokeAt.getTime() < FEEDBACK_EXTRACT_QUIET_WINDOW_MS
  );
}
