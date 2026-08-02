import type { EventDtoOutputStatus } from "../../api/generated/model/eventDtoOutputStatus";

/**
 * The four event statuses.
 *
 * Every generated union that carries one — list item, detail, participant
 * history, the transition body — is the same four members, so one alias serves
 * all of them and callers do not cast between identical types.
 */
export type EventStatus = EventDtoOutputStatus;

/**
 * The same four statuses as a value, for boundaries that must recognise one at
 * runtime rather than merely type-check it. The `Record`s below already fail to
 * compile if the generated union gains a member, so this list cannot silently
 * fall behind it.
 */
export const EVENT_STATUSES = [
  "draft",
  "scheduled",
  "finished",
  "cancelled",
] as const satisfies readonly EventStatus[];

const STATUS_LABELS: Record<EventStatus, string> = {
  draft: "Draft",
  scheduled: "Scheduled",
  finished: "Finished",
  cancelled: "Cancelled",
};

/** HeroUI `Chip` colours. The palette has no `info`, so `accent` carries «ahead of us». */
export type EventStatusColor = "default" | "accent" | "success" | "danger";

const STATUS_COLORS: Record<EventStatus, EventStatusColor> = {
  draft: "default",
  scheduled: "accent",
  finished: "success",
  cancelled: "danger",
};

export function eventStatusLabel(status: EventStatus): string {
  return STATUS_LABELS[status];
}

export function eventStatusColor(status: EventStatus): EventStatusColor {
  return STATUS_COLORS[status];
}

/**
 * What pressing the button *does*, not what the row becomes. «Mark scheduled»
 * named the destination and left the operator to work out the verb; these name
 * the act, which is what a button label is for.
 */
const TRANSITION_LABELS: Record<EventStatus, string> = {
  draft: "Return to draft",
  scheduled: "Schedule",
  finished: "Mark finished",
  cancelled: "Cancel event",
};

export function eventTransitionLabel(target: EventStatus): string {
  return TRANSITION_LABELS[target];
}

/** Title and start edits are refused once an event reaches a terminal status. */
export function isEventEditable(status: EventStatus): boolean {
  return status === "draft" || status === "scheduled";
}

/** Venue context can be corrected after a dinner; only cancellation freezes it. */
export function isEventVenueEditable(status: EventStatus): boolean {
  return status !== "cancelled";
}

/**
 * Cancelled events refuse attendee inserts; finished ones still accept late
 * adds, because someone who came is a fact the record has to be able to gain.
 */
export function acceptsNewAttendees(status: EventStatus): boolean {
  return status !== "cancelled";
}
