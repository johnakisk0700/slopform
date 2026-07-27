/**
 * Why an operator closed a conversation.
 *
 * Mirrors the backend's `FEEDBACK_STAFF_CLOSE_REASONS`. Kept here rather than
 * imported from the generated client so the close dialog can ship before
 * `pnpm api:generate` regenerates the DTO — the values are the contract, and a
 * drift against the backend enum fails the close request rather than the build.
 */
export const STAFF_CLOSE_REASONS = [
  "abusive",
  "unresponsive",
  "handled_offline",
  "duplicate",
  "other",
] as const;

export type StaffCloseReason = (typeof STAFF_CLOSE_REASONS)[number];

export const STAFF_CLOSE_NOTE_MAX_LENGTH = 500;

export interface StaffCloseInput {
  reason: StaffCloseReason;
  note?: string;
}

const STAFF_CLOSE_REASON_LABELS: Record<StaffCloseReason, string> = {
  abusive: "Abusive",
  unresponsive: "Unresponsive",
  handled_offline: "Handled offline",
  duplicate: "Duplicate",
  other: "Other",
};

export function staffCloseReasonLabel(reason: StaffCloseReason): string {
  return STAFF_CLOSE_REASON_LABELS[reason];
}

/**
 * The line under the lifecycle badge on a staff-cancelled conversation.
 *
 * Without it, every human close still reads as the bare «Cancelled» the
 * lifecycle enum can say, and a month later nobody can tell an abusive thread
 * from one handled by phone.
 */
export function staffCloseSummary(staffClose: {
  reason: StaffCloseReason;
  note: string | null;
}): string {
  const label = staffCloseReasonLabel(staffClose.reason);
  if (staffClose.note) {
    return `Closed as ${label.toLowerCase()} — ${staffClose.note}`;
  }
  return `Closed as ${label.toLowerCase()}`;
}
