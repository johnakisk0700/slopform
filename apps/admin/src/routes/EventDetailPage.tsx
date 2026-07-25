import { Button, Input } from "@heroui/react";
import type { ColumnDef } from "@tanstack/react-table";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { Link, useParams } from "react-router";

import { JtsDataTable } from "../components/ui/JtsDataTable";
import { JtsPageHeader } from "../components/ui/JtsPageHeader";
import {
  eventDetailSchema,
  nextEventStatuses,
  type EventAttendee,
  type EventDetail,
  type EventStatus,
} from "../features/event/schema";
import {
  participantListSchema,
  type Participant,
} from "../features/participant/schema";
import { api } from "../lib/api";
import { usePageMeta } from "../lib/usePageMeta";

const EVENTS_PATH = "/v1/events";
const PARTICIPANTS_PATH = "/v1/participants";

function toDateTimeLocalValue(iso: string): string {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Minimal event edit + attendance screen for stub events (WP1). */
export function EventDetailPage() {
  const { eventId = "" } = useParams();
  usePageMeta("Event", "Edit stub event details and attendance.");

  const [event, setEvent] = useState<EventDetail | null>(null);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [title, setTitle] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [participantId, setParticipantId] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!eventId) {
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [detail, participantPayload] = await Promise.all([
        api(`${EVENTS_PATH}/${eventId}`),
        api(PARTICIPANTS_PATH),
      ]);
      const parsed = eventDetailSchema.parse(detail);
      setEvent(parsed);
      setTitle(parsed.title);
      setStartsAt(toDateTimeLocalValue(parsed.startsAt));
      setParticipants(participantListSchema.parse(participantPayload).items);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Failed to load event.",
      );
    } finally {
      setLoading(false);
    }
  }, [eventId]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [load]);

  const availableParticipants = useMemo(() => {
    const assigned = new Set(event?.attendees.map((row) => row.participantId));
    return participants.filter((row) => !assigned.has(row.id));
  }, [event, participants]);

  async function updateAttendee(
    attendeeId: string,
    body: { present?: boolean; tableNo?: number | null },
  ) {
    setSaving(true);
    setError(null);
    try {
      await api(`${EVENTS_PATH}/${eventId}/attendees/${attendeeId}`, {
        method: "PUT",
        body,
      });
      await load();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Failed to update attendee.",
      );
    } finally {
      setSaving(false);
    }
  }

  const columns = useMemo<ColumnDef<EventAttendee>[]>(
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

  async function onSaveDetails(formEvent: FormEvent<HTMLFormElement>) {
    formEvent.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await api(`${EVENTS_PATH}/${eventId}`, {
        method: "PATCH",
        body: {
          title,
          startsAt: new Date(startsAt).toISOString(),
        },
      });
      await load();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Failed to save event.",
      );
    } finally {
      setSaving(false);
    }
  }

  async function onTransition(status: EventStatus) {
    setSaving(true);
    setError(null);
    try {
      await api(`${EVENTS_PATH}/${eventId}/status`, {
        method: "POST",
        body: { status },
      });
      await load();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Failed to transition event status.",
      );
    } finally {
      setSaving(false);
    }
  }

  async function onAddAttendee(formEvent: FormEvent<HTMLFormElement>) {
    formEvent.preventDefault();
    if (!participantId) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api(`${EVENTS_PATH}/${eventId}/attendees`, {
        method: "POST",
        body: { participantId, present: true },
      });
      setParticipantId("");
      await load();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Failed to add attendee.",
      );
    } finally {
      setSaving(false);
    }
  }

  if (loading && !event) {
    return <p role="status">Loading event…</p>;
  }

  if (!event) {
    return (
      <div className="flex flex-col gap-4">
        <p role="alert">{error ?? "Event not found."}</p>
        <Link to="/admin/events">Back to events</Link>
      </div>
    );
  }

  const transitions = nextEventStatuses(event.status);
  const editable = event.status === "draft" || event.status === "scheduled";

  return (
    <div className="flex flex-col gap-8">
      <JtsPageHeader
        eyebrow="Operations"
        title={event.title}
        description={`Status: ${event.status}. Attendance corrections use present updates — no row deletion for finished events.`}
        actions={
          <Link
            to="/admin/events"
            className="text-sm font-semibold text-primary"
          >
            Back to list
          </Link>
        }
      />

      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}

      <form
        onSubmit={onSaveDetails}
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
        onSubmit={onAddAttendee}
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
