import { Button, Checkbox, Chip, Input } from "@heroui/react";
import type { ColumnDef } from "@tanstack/react-table";
import { CalendarClock, Inbox, PencilLine, Users } from "lucide-react";
import { type FormEvent, useMemo, useState } from "react";
import { Link, useParams } from "react-router";

import {
  useAddEventAttendee,
  useGetEvent,
  useTransitionEventStatus,
  useUpdateEvent,
  useUpdateEventAttendee,
} from "../api/generated/events";
import type { EventDetailDtoOutput } from "../api/generated/model/eventDetailDtoOutput";
import type { EventDetailDtoOutputAttendeesItem } from "../api/generated/model/eventDetailDtoOutputAttendeesItem";
import type { ParticipantDtoOutput } from "../api/generated/model/participantDtoOutput";
import { useListParticipants } from "../api/generated/participants";
import { AddAttendeeAction } from "../components/admin/events/AddAttendeeAction";
import { EventStatusChip } from "../components/admin/events/EventStatusChip";
import { EventVenueCard } from "../components/admin/events/EventVenueCard";
import { ParticipantIdentity } from "../components/admin/participants/ParticipantIdentity";
import { JtsBackLink } from "../components/ui/JtsBackLink";
import { JtsDataTable } from "../components/ui/JtsDataTable";
import { JtsPageHeader } from "../components/ui/JtsPageHeader";
import {
  acceptsNewAttendees,
  eventTransitionLabel,
  isEventEditable,
  isEventVenueEditable,
  type EventStatus,
} from "../features/event/eventStatus";
import { nextEventStatuses } from "../features/event/nextEventStatuses";
import type { EventVenueUpdate } from "../features/event/venue";
import { apiErrorMessage } from "../lib/api";
import { formatDateTime } from "../lib/dateTime";
import { usePageMeta } from "../lib/usePageMeta";

function toDateTimeLocalValue(iso: string): string {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Named once so the header and the not-found branch cannot drift apart. */
const BACK_TO_EVENTS = { to: "/admin/events", label: "Back to events" };

interface EventDetailsFormProps {
  event: EventDetailDtoOutput;
  saving: boolean;
  onSave: (details: { title: string; startsAt: string }) => Promise<void>;
}

/**
 * Title and start time, shown only while the event can still take them. Once
 * it is finished or cancelled the backend refuses the edit, and a form whose
 * every control is dead is just a paragraph pretending to be one.
 */
function EventDetailsForm({ event, saving, onSave }: EventDetailsFormProps) {
  const [title, setTitle] = useState(event.title);
  const [startsAt, setStartsAt] = useState(
    toDateTimeLocalValue(event.startsAt),
  );

  async function handleSubmit(formEvent: FormEvent<HTMLFormElement>) {
    formEvent.preventDefault();
    await onSave({ title, startsAt });
  }

  return (
    <section
      aria-labelledby="event-details-heading"
      className="rounded-md border border-border bg-surface px-4 py-4"
    >
      <h2
        id="event-details-heading"
        className="mb-4 flex items-center gap-2 jts-overline text-ink-muted"
      >
        <PencilLine aria-hidden="true" className="size-4 shrink-0" />
        Event details
      </h2>
      <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-3">
        <div className="grid min-w-[16rem] flex-1 gap-1.5">
          <label htmlFor="event-title" className="text-sm font-semibold">
            Title
          </label>
          <Input
            id="event-title"
            value={title}
            onChange={(change) => setTitle(change.target.value)}
            disabled={saving}
            required
          />
        </div>
        <div className="grid min-w-[14rem] gap-1.5">
          <label htmlFor="event-starts-at" className="text-sm font-semibold">
            Starts at
          </label>
          <Input
            id="event-starts-at"
            type="datetime-local"
            value={startsAt}
            onChange={(change) => setStartsAt(change.target.value)}
            disabled={saving}
            required
          />
        </div>
        <Button type="submit" variant="secondary" isDisabled={saving}>
          Save details
        </Button>
      </form>
    </section>
  );
}

/** One event: its standing, who came, and where they sat. */
export function EventDetailPage() {
  const { eventId = "" } = useParams();
  usePageMeta("Event", "Edit event details, venue and attendance.");

  const eventQuery = useGetEvent(eventId, {
    query: { enabled: eventId !== "" },
  });
  const participantsQuery = useListParticipants();
  const updateEvent = useUpdateEvent();
  const updateEventVenue = useUpdateEvent();
  const transitionEventStatus = useTransitionEventStatus();
  const addEventAttendee = useAddEventAttendee();
  const updateEventAttendee = useUpdateEventAttendee();

  const [actionError, setActionError] = useState<string | null>(null);
  const [savingAttendeeId, setSavingAttendeeId] = useState<string | null>(null);

  const event = eventQuery.data;

  const savingEvent = updateEvent.isPending || transitionEventStatus.isPending;
  const loading =
    eventQuery.isPending ||
    eventQuery.isFetching ||
    participantsQuery.isPending ||
    participantsQuery.isFetching;

  const loadError = eventQuery.isError
    ? apiErrorMessage(eventQuery.error, "Failed to load event.")
    : participantsQuery.isError
      ? apiErrorMessage(participantsQuery.error, "Failed to load event.")
      : null;

  async function refetchEvent() {
    await Promise.all([eventQuery.refetch(), participantsQuery.refetch()]);
  }

  const availableParticipants = useMemo<ParticipantDtoOutput[]>(() => {
    const participantRows = participantsQuery.data?.items ?? [];
    const assigned = new Set(event?.attendees.map((row) => row.participantId));
    return participantRows.filter((row) => !assigned.has(row.id));
  }, [event, participantsQuery.data?.items]);

  async function updateAttendee(
    attendeeId: string,
    body: { present?: boolean; tableNo?: number | null },
  ) {
    setActionError(null);
    setSavingAttendeeId(attendeeId);
    try {
      await updateEventAttendee.mutateAsync({
        id: eventId,
        attendeeId,
        data: body,
      });
      await refetchEvent();
    } catch (cause) {
      setActionError(apiErrorMessage(cause, "Failed to update attendee."));
    } finally {
      setSavingAttendeeId(null);
    }
  }

  const columns = useMemo<ColumnDef<EventDetailDtoOutputAttendeesItem>[]>(
    () => [
      {
        accessorKey: "preferredName",
        header: "Participant",
        cell: ({ row }) => (
          <ParticipantIdentity
            preferredName={row.original.preferredName}
            emailNormalized={row.original.emailNormalized}
            to={`/admin/participants/${row.original.participantId}`}
          />
        ),
      },
      {
        accessorKey: "tableNo",
        header: "Table",
        meta: { align: "end" },
        // Read-only on purpose: seating is the «Tables & matching» area's to
        // assign, and this screen was offering a bare number field for it with
        // no sense of which tables exist or who is already at them.
        cell: ({ row }) =>
          row.original.tableNo === null ? (
            <span className="text-ink-subtle">—</span>
          ) : (
            <Chip color="default" size="sm" variant="soft">
              <Chip.Label>Table {row.original.tableNo}</Chip.Label>
            </Chip>
          ),
      },
      {
        accessorKey: "present",
        // «Attendance», and «Attended / No-show» below it: the same pair the
        // participant profile's dinner history already uses, so one fact is
        // not called two different things on two screens.
        header: "Attendance",
        meta: { align: "end" },
        cell: ({ row }) => (
          <div className="flex justify-end">
            <Checkbox
              isSelected={row.original.present}
              isDisabled={
                savingAttendeeId !== null || event?.status === "cancelled"
              }
              onChange={(present) => {
                void updateAttendee(row.original.id, { present });
              }}
            >
              <Checkbox.Content>
                <Checkbox.Control>
                  <Checkbox.Indicator />
                </Checkbox.Control>
                {/* A span, not HeroUI's `Label`: `Checkbox.Content` already
                    renders the `<label>` that names the control, and nesting a
                    second one inside it is invalid HTML. */}
                <span className="text-sm">
                  {row.original.present ? "Attended" : "No-show"}
                </span>
              </Checkbox.Content>
            </Checkbox>
          </div>
        ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload refreshes handlers
    [event?.status, savingAttendeeId, eventId],
  );

  async function saveEventDetails(details: {
    title: string;
    startsAt: string;
  }) {
    setActionError(null);
    try {
      await updateEvent.mutateAsync({
        id: eventId,
        data: {
          title: details.title,
          startsAt: new Date(details.startsAt).toISOString(),
        },
      });
      await refetchEvent();
    } catch (cause) {
      setActionError(apiErrorMessage(cause, "Failed to save event."));
    }
  }

  async function saveEventVenue(venue: EventVenueUpdate | null) {
    await updateEventVenue.mutateAsync({
      id: eventId,
      data: { venue },
    });
    await eventQuery.refetch();
  }

  async function transitionEvent(status: EventStatus) {
    setActionError(null);
    try {
      await transitionEventStatus.mutateAsync({
        id: eventId,
        data: { status },
      });
      await refetchEvent();
    } catch (cause) {
      setActionError(
        apiErrorMessage(cause, "Failed to transition event status."),
      );
    }
  }

  async function addAttendee(participantId: string) {
    setActionError(null);
    await addEventAttendee.mutateAsync({
      id: eventId,
      data: { participantId, present: true },
    });
    await refetchEvent();
  }

  const awaitingInitial =
    (eventQuery.isPending || participantsQuery.isPending) && !event;

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
        eyebrow="Operations"
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
