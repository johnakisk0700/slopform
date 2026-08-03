const MIN_REPLY_HEIGHT_PX = 300;
const QUESTION_TOP_AND_MESSAGE_GAP_PX = 24;

/**
 * Reserve the visible space below the newest question for its answer.
 *
 * The question is aligned 12px below the scroll viewport and the message grid
 * contributes another 12px gap. Keeping both in the calculation makes a short
 * settled reply occupy the remainder of the visible chat instead of collapsing
 * the page and pulling the question back down.
 */
export function calculateAssistantReplyMinHeight(
  viewportHeight: number,
  userMessageHeight: number,
): number {
  return Math.max(
    viewportHeight - userMessageHeight - QUESTION_TOP_AND_MESSAGE_GAP_PX,
    MIN_REPLY_HEIGHT_PX,
  );
}
