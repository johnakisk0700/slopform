/**
 * Whether the pipeline still owes a conversation an outbound turn.
 *
 * Input quiescence alone says only that the system finished digesting what we
 * sent; a bot reply can still be mid-flight when the last inject goes quiet,
 * and grading at that instant reads a missing message the worker is about to
 * write. `running` is always in flight — it is admitted only by a live
 * execution lease. `scheduled` counts only while its `nextActionAt` is due or
 * lands inside `horizonMs`: a debounced reply about to fire must be waited
 * out, while a reminder scheduled hours ahead must not deadlock settlement.
 * Overdue-forever stays in flight on purpose — a dead worker is a run that
 * genuinely did not finish, and the deadline is what bounds the wait.
 */
export function feedbackBurstOutboundInFlight(automation, nowMs, horizonMs) {
  if (!automation) {
    return false;
  }
  if (automation.state === "running") {
    return true;
  }
  if (automation.state !== "scheduled" || automation.nextActionAt === null) {
    return false;
  }
  const due = Date.parse(automation.nextActionAt);
  return !Number.isNaN(due) && due <= nowMs + horizonMs;
}
