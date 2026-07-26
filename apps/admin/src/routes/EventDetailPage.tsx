import { Button, Input } from "@heroui/react";
import type { ColumnDef } from "@tanstack/react-table";
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
import type { EventDtoOutputStatus } from "../api/generated/model/eventDtoOutputStatus";
import type { ParticipantDtoOutput } from "../api/generated/model/participantDtoOutput";
import { useListParticipants } from "../api/generated/participants";
import { JtsDataTable } from "../components/ui/JtsDataTable";
import { JtsPageHeader } from "../components/ui/JtsPageHeader";
import { nextEventStatuses } from "../features/event/nextEventStatuses";
import { apiErrorMessage } from "../lib/api";
import { usePageMeta } from "../lib/usePageMeta";

function toDateTimeLocalValue(iso: string): string {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

interface EventDetailEditorProps {
  event: EventDetailDtoOutput;
  availableParticipants: ParticipantDtoOutput[];
  saving: boolean;
  onSaveDetails: (details: {
    title: string;
    startsAt: string;
  }) => Promise<void>;
  onTransition: (status: EventDtoOutputStatus) => Promise<void>;
  onAddAttendee: (participantId: string) => Promise<void>;
}

function EventDetailEditor({
  event,
  availableParticipants,
  saving,
  onSaveDetails: saveDetails,
  onTransition,
  onAddAttendee: addAttendee,
}: EventDetailEditorProps) {
  const [title, setTitle] = useState(event.title);
  const [startsAt, setStartsAt] = useState(
    toDateTimeLocalValue(event.startsAt),
  );
  const [participantId, setParticipantId] = useState("");

  const transitions = nextEventStatuses(event.status);
  const editable = event.status === "draft" || event.status === "scheduled";

  async function handleSaveDetails(formEvent: FormEvent<HTMLFormElement>) {
    formEvent.preventDefault();
    await saveDetails({ title, startsAt });
  }

  async function handleAddAttendee(formEvent: FormEvent<HTMLFormElement>) {
    formEvent.preventDefault();
    if (!participantId) {
      return;
    }
    await addAttendee(participantId);
    setParticipantId("");
  }

  return (
    <>
      <form
        onSubmit={handleSaveDetails}
        className="flex flex-wrap items-end gap-3 rounded-md border border-border p-4"
      >
        <div className="grid min-w-[16rem] flex-1 gap-1.5">
          <label htmlFor="event-title" className="text-sm font-semibold">
            Title
          </label>
          <Input
            id="event-title"
            value={title}
            onChange={(change) => setTitle(change.target.value)}
            disabled={!editable || saving}
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
            disabled={!editable || saving}
            required
          />
        </div>
        <Button type="submit" isDisabled={!editable || saving}>
          Save details
        </Button>
      </form>

      {transitions.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {transitions.map((status) => (
            <Button
              key={status}
              onPress={() => {
                void onTransition(status);
              }}
              isDisabled={saving}
            >
              Mark {status}
            </Button>
          ))}
        </div>
      ) : null}

      <form
        onSubmit={handleAddAttendee}
        className="flex flex-wrap items-end gap-3 rounded-md border border-border p-4"
      >
        <label className="flex min-w-[16rem] flex-1 flex-col gap-1 text-sm">
          <span className="font-semibold">Add participant</span>
          <select
            value={participantId}
            onChange={(change) => setParticipantId(change.target.value)}
            disabled={
              event.status === "cancelled" ||
              availableParticipants.length === 0 ||
              saving
            }
            className="min-h-10 rounded-md border border-border bg-surface px-3"
            required
          >
            <option value="">Select participant</option>
            {availableParticipants.map((row) => (
              <option key={row.id} value={row.id}>
                {row.preferredName ?? row.emailNormalized}
              </option>
            ))}
          </select>
        </label>
        <Button
          type="submit"
          isDisabled={event.status === "cancelled" || saving}
        >
          Add attendee
        </Button>
      </form>
    </>
  );
}

/** Minimal event edit + attendance screen for stub events (WP1). */
export function EventDetailPage() {
  const { eventId = "" } = useParams();
  usePageMeta("Event", "Edit stub event details and attendance.");

  const eventQuery = useGetEvent(eventId, {
    query: { enabled: eventId !== "" },
  });
  const participantsQuery = useListParticipants();
  const updateEvent = useUpdateEvent();
  const transitionEventStatus = useTransitionEventStatus();
  const addEventAttendee = useAddEventAttendee();
  const updateEventAttendee = useUpdateEventAttendee();

  const [actionError, setActionError] = useState<string | null>(null);

  const event = eventQuery.data;

  const saving =
    updateEvent.isPending ||
    transitionEventStatus.isPending ||
    addEventAttendee.isPending ||
    updateEventAttendee.isPending;

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
    try {
      await updateEventAttendee.mutateAsync({
        id: eventId,
        attendeeId,
        data: body,
      });
      await refetchEvent();
    } catch (cause) {
      setActionError(apiErrorMessage(cause, "Failed to update attendee."));
    }
  }

  const columns = useMemo<ColumnDef<EventDetailDtoOutputAttendeesItem>[]>(
    () => [
      {
        accessorKey: "preferredName",
        header: "Participant",
        cell: ({ row }) =>
          row.original.preferredName ?? row.original.emailNormalized,
      },
      {
        accessorKey: "present",
        header: "Present",
        cell: ({ row }) => (
          <label className="inline-flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={row.original.present}
              disabled={saving || event?.status === "cancelled"}
              onChange={(change) => {
                void updateAttendee(row.original.id, {
                  present: change.target.checked,
                });
              }}
            />
            Present
          </label>
        ),
      },
      {
        accessorKey: "tableNo",
        header: "Table",
        cell: ({ row }) => (
          <Input
            aria-label={`Table for ${row.original.preferredName ?? row.original.emailNormalized}`}
            type="number"
            min={1}
            max={999}
            defaultValue={row.original.tableNo?.toString() ?? ""}
            disabled={saving || event?.status === "cancelled"}
            onBlur={(change) => {
              const raw = change.target.value.trim();
              const tableNo = raw === "" ? null : Number(raw);
              if (tableNo === row.original.tableNo) {
                return;
              }
              if (
                tableNo !== null &&
                (!Number.isInteger(tableNo) || tableNo < 1)
              ) {
                return;
              }
              void updateAttendee(row.original.id, { tableNo });
            }}
            className="max-w-[7rem]"
          />
        ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload refreshes handlers
    [event?.status, saving, eventId],
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

  async function transitionEvent(status: EventDtoOutputStatus) {
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
    try {
      await addEventAttendee.mutateAsync({
        id: eventId,
        data: { participantId, present: true },
      });
      await refetchEvent();
    } catch (cause) {
      setActionError(apiErrorMessage(cause, "Failed to add attendee."));
    }
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
        <Link to="/admin/events">Back to events</Link>
      </div>
    );
  }

  const error = actionError ?? loadError;

  return (
    <div className="flex flex-col gap-8">
      <JtsPageHeader
        eyebrow="Operations"
        title={event.title}
        description={`Status: ${event.status}. Attendance corrections use present updates — no row deletion for finished events.`}
        actions={
          <div className="flex flex-wrap items-center gap-3">
            {event.feedbackCampaignId ? (
              <Link
                to={`/admin/feedback/${event.feedbackCampaignId}`}
                className="text-sm font-semibold text-primary"
              >
                Open inbox
              </Link>
            ) : null}
            <Link
              to="/admin/events"
              className="text-sm font-semibold text-primary"
            >
              Back to list
            </Link>
          </div>
        }
      />

      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}

      <EventDetailEditor
        key={event.updatedAt}
        event={event}
        availableParticipants={availableParticipants}
        saving={saving}
        onSaveDetails={saveEventDetails}
        onTransition={transitionEvent}
        onAddAttendee={addAttendee}
      />

      <JtsDataTable
        title="Attendance"
        rows={event.attendees}
        columns={columns}
        getRowId={(row) => row.id}
        loading={loading}
        emptyTitle="No attendees"
        emptyDescription="Add participants who attended this event."
      />
    </div>
  );
}
