import { Button } from "@heroui/react";
import { CalendarClock, Inbox, Users } from "lucide-react";
import { Link } from "react-router";

import { AddAttendeeAction } from "../../components/admin/events/AddAttendeeAction";
import { EventStatusChip } from "../../components/admin/events/EventStatusChip";
import { EventVenueCard } from "../../components/admin/events/EventVenueCard";
import { JtsBackLink } from "../../components/ui/JtsBackLink";
import { JtsDataTable } from "../../components/ui/JtsDataTable";
import { JtsPageHeader } from "../../components/ui/JtsPageHeader";
import {
  acceptsNewAttendees,
  eventTransitionLabel,
  isEventEditable,
  isEventVenueEditable,
} from "../../features/event/eventStatus";
import { nextEventStatuses } from "../../features/event/nextEventStatuses";
import { formatDateTime } from "../../lib/dateTime";
import { usePageMeta } from "../../lib/usePageMeta";

import { EventDetailsForm } from "./EventDetailsForm";
import { useEventDetailControls } from "./useEventDetailControls";

const BACK_TO_EVENTS = { to: "/admin/events", label: "Back to events" };
export function EventDetailPage() {
  const {
    updateEventVenue,
    addEventAttendee,
    actionError,
    event,
    savingEvent,
    loading,
    loadError,
    availableParticipants,
    columns,
    saveEventDetails,
    saveEventVenue,
    transitionEvent,
    addAttendee,
    awaitingInitial,
  } = useEventDetailControls();

  usePageMeta("Event", "Edit event details, venue and attendance.");

  if (awaitingInitial) {
    return <p role="status">Loading event…</p>;
  }

  if (!event) {
    return (
      <div className="flex flex-col gap-4">
        <p role="alert">{loadError ?? actionError ?? "Event not found."}</p>
        <JtsBackLink to={BACK_TO_EVENTS.to}>{BACK_TO_EVENTS.label}</JtsBackLink>
      </div>
    );
  }

  const error = actionError ?? loadError;

  const transitions = nextEventStatuses(event.status);

  const presentCount = event.attendees.filter((row) => row.present).length;

  return (
    <div className="flex flex-col gap-6">
      <JtsPageHeader
        back={BACK_TO_EVENTS}

        title={event.title}
        description="Who actually showed up is the one thing only you know. Correct it, then finish the event — everything after this reads from that list."
      />

      {/* Standing on the left, what you can do about it on the right — so the
          operator reads the state before reaching the buttons that change it. */}
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 rounded-md border border-border bg-surface px-4 py-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-ink-muted">
          <EventStatusChip status={event.status} />
          <span className="inline-flex items-center gap-1.5">
            <CalendarClock
              aria-hidden="true"
              className="size-4 shrink-0 text-ink-subtle"
            />
            <span className="tabular-nums">
              {formatDateTime(event.startsAt)}
            </span>
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Users
              aria-hidden="true"
              className="size-4 shrink-0 text-ink-subtle"
            />
            <span className="tabular-nums">
              {presentCount} of {event.attendees.length} attended
            </span>
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {event.feedbackCampaignId ? (
            <Link
              to={`/admin/feedback/${event.feedbackCampaignId}`}
              className="inline-flex items-center gap-1.5 text-sm font-semibold text-primary"
            >
              <Inbox aria-hidden="true" className="size-4 shrink-0" />
              Open inbox
            </Link>
          ) : null}
          {transitions.map((status) => (
            <Button
              key={status}
              size="sm"
              variant={status === "cancelled" ? "danger-soft" : "secondary"}
              onPress={() => {
                void transitionEvent(status);
              }}
              isDisabled={savingEvent}
            >
              {eventTransitionLabel(status)}
            </Button>
          ))}
        </div>
      </div>

      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}

      <EventVenueCard
        venue={event.venue}
        canEdit={isEventVenueEditable(event.status)}
        isPending={updateEventVenue.isPending}
        onSave={saveEventVenue}
      />

      {isEventEditable(event.status) ? (
        <EventDetailsForm
          key={event.updatedAt}
          event={event}
          saving={savingEvent}
          onSave={saveEventDetails}
        />
      ) : null}

      <JtsDataTable
        title="Attendance"
        description="Someone who did not come is marked as a no-show, never removed — the record keeps them."
        rows={event.attendees}
        columns={columns}
        getRowId={(row) => row.id}
        loading={loading}
        emptyTitle="Nobody on this event yet"
        emptyDescription="Add the people who sat down to this dinner."
        emptyIcon={
          <Users
            aria-hidden="true"
            className="size-9 text-ink-subtle"
            strokeWidth={1.5}
          />
        }
        toolbarEnd={
          <AddAttendeeAction
            availableParticipants={availableParticipants}
            isDisabled={!acceptsNewAttendees(event.status)}
            isPending={addEventAttendee.isPending}
            onAdd={addAttendee}
          />
        }
      />
    </div>
  );
}
