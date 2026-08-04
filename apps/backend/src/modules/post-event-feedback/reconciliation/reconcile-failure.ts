/**
 * Stable BullMQ failed-reason marker for a quarantined reconciliation revision.
 *
 * Maintenance compares this value exactly before deciding whether a retained
 * failed job may be replaced. Keep the value versioned if its meaning changes.
 */
export const FEEDBACK_RECONCILIATION_INVARIANT_FAILURE_REASON =
  "feedback.reconciliation.execution_invariant_broken.v1";
