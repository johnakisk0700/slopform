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
