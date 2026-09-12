import { Checkbox, Chip } from "@heroui/react";
import type { ColumnDef } from "@tanstack/react-table";
import { useMemo, useState } from "react";
import { useParams } from "react-router";

import {
  useAddEventAttendee,
  useGetEvent,
  useTransitionEventStatus,
  useUpdateEvent,
  useUpdateEventAttendee,
} from "../../api/generated/events";
import type { EventDetailDtoOutputAttendeesItem } from "../../api/generated/model/eventDetailDtoOutputAttendeesItem";
import { useListParticipants } from "../../api/generated/participants";
import { ParticipantIdentity } from "../../components/admin/participants/ParticipantIdentity";
import { type EventStatus } from "../../features/event/eventStatus";
import type { EventVenueUpdate } from "../../features/event/venue";
import { apiErrorMessage } from "../../lib/api";

export function useEventDetailControls() {
  const { eventId = "" } = useParams();

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

  const availableParticipants = useMemo(() => {
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
  return {
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
  };
}
