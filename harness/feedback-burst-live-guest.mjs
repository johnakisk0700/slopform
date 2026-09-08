/**
 * Whether an improvised guest must stop before spending another persona-model
 * call or injecting another message.
 *
 * `awaitingHuman` is deliberately independent of bot/human control. The bot may
 * still own the conversation while its safety handoff waits for staff, and a
 * capability-derived check would therefore continue talking into silence.
 */
export function feedbackBurstLiveGuestStopReason(detail) {
  if (detail?.lifecycle?.state !== "open") {
    return {
      kind: "closed",
      reason: detail?.lifecycle?.reason ?? null,
    };
  }
  if (detail.awaitingHuman === true) {
    return { kind: "awaiting_human", reason: null };
  }
  return null;
}

/**
 * Attention-reason kinds whose unresolved presence means the product has
 * escalated to a human and correctly gone quiet. Quality-of-answer kinds such
 * as `answer_revision` do not belong here: the bot keeps talking through those.
 */
export const FEEDBACK_BURST_HANDOFF_ATTENTION_KINDS = new Set([
  "safety",
  "handoff",
  "respondent_conduct",
]);

/**
 * Whether the conversation's final silence is the product declining to reply
 * because a human handoff is pending, rather than a dropped send.
 *
 * This is deliberately a grading concern and not folded into
 * `feedbackBurstLiveGuestStopReason`: the stop reason governs whether we spend
 * another persona-model call, and widening it would make the guest fall silent
 * on any unresolved flag. Grading can afford the broader view — a scripted run
 * can freeze on `awaitingHuman` before the automation delivers its first
 * reply, and a live guest can time out with unresolved safety reasons that
 * never flipped `awaitingHuman`; both are the safety posture working, and the
 * delivery lower bound should not call them a lost message. Only unresolved
 * reasons count, because a resolved one means the bot resumed and owes its
 * reply again.
 */
export function feedbackBurstReplySuppressedByHandoff(detail) {
  if (detail?.awaitingHuman === true) {
    return true;
  }
  const reasons = detail?.attentionReasons;
  if (!Array.isArray(reasons)) {
    return false;
  }
  return reasons.some(
    (reason) =>
      reason?.resolvedAt === null &&
      FEEDBACK_BURST_HANDOFF_ATTENTION_KINDS.has(reason?.kind),
  );
}
