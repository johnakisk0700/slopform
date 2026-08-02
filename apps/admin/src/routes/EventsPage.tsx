import type { ColumnDef } from "@tanstack/react-table";
import { CalendarRange } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router";

import { useCreateEvent, useListEvents } from "../api/generated/events";
import type { EventListDtoOutputItemsItem } from "../api/generated/model/eventListDtoOutputItemsItem";
import { CreateEventAction } from "../components/admin/events/CreateEventAction";
import { EventStatusChip } from "../components/admin/events/EventStatusChip";
import { VenuePill } from "../components/admin/events/VenuePill";
import { JtsDataTable } from "../components/ui/JtsDataTable";
import { JtsPageHeader } from "../components/ui/JtsPageHeader";
import { apiErrorMessage } from "../lib/api";
import { formatDateTime } from "../lib/dateTime";
import { usePageMeta } from "../lib/usePageMeta";

const columns: ColumnDef<EventListDtoOutputItemsItem>[] = [
  {
    accessorKey: "title",
    header: "Event",
    cell: ({ row }) => (
      <div className="grid min-w-0 gap-1.5">
        <Link
          to={`/admin/events/${row.original.id}`}
          className="truncate font-bold text-primary underline-offset-2 hover:underline"
        >
          {row.original.title}
        </Link>
        {row.original.venue ? (
          <div>
            <VenuePill venue={row.original.venue} />
          </div>
        ) : null}
      </div>
    ),
  },
  {
    accessorKey: "startsAt",
    header: "Starts",
    cell: ({ row }) => (
      <span className="tabular-nums">
        {formatDateTime(row.original.startsAt)}
      </span>
    ),
  },
  {
    accessorKey: "status",
    header: "Status",
    cell: ({ row }) => <EventStatusChip status={row.original.status} />,
  },
  {
    id: "attendance",
    header: "Attended",
    meta: { align: "end" },
    // The present count is the number an operator is looking for; the total is
    // the context it needs to mean anything, so it stays but steps back.
    cell: ({ row }) => (
      <span className="tabular-nums">
        <strong className="font-bold text-ink">
          {row.original.presentCount}
        </strong>
        <span className="text-ink-muted"> / {row.original.attendeeCount}</span>
      </span>
    ),
  },
];

/** Every dinner on file: when it is, where it stands, and how many sat down. */
export function EventsPage() {
  usePageMeta("Events", "Events, venues, attendance and table assignments.");

  const eventsQuery = useListEvents();
  const createEvent = useCreateEvent();

  const [actionError, setActionError] = useState<string | null>(null);

  // Newest first: the event an operator opens is nearly always the last one
  // that happened. Clicking a header still takes the table over from here.
  const rows = useMemo(
    () =>
      [...(eventsQuery.data?.items ?? [])].sort(
        (left, right) =>
          new Date(right.startsAt).getTime() -
          new Date(left.startsAt).getTime(),
      ),
    [eventsQuery.data?.items],
  );

  const loading = eventsQuery.isPending || eventsQuery.isFetching;
  const error = eventsQuery.isError
    ? apiErrorMessage(eventsQuery.error, "Failed to load events.")
    : actionError;

  async function createNewEvent(details: { title: string; startsAt: string }) {
    setActionError(null);
    await createEvent.mutateAsync({
      data: {
        title: details.title,
        startsAt: new Date(details.startsAt).toISOString(),
      },
    });
    await eventsQuery.refetch();
  }

  return (
    <div className="flex flex-col gap-6">
      <JtsPageHeader
        eyebrow="Operations"
        title="Events"
        description="Create an event, correct who came, and finish it before launching feedback."
      />

      <JtsDataTable
        title="Events"
        rows={rows}
        columns={columns}
        getRowId={(row) => row.id}
        loading={loading}
        error={error}
        paginator
        pageSize={25}
        rowsPerPageOptions={[25, 50, 100]}
        emptyTitle="No events yet"
        emptyDescription="Create one to start recording attendance."
        emptyIcon={
          <CalendarRange
            aria-hidden="true"
            className="size-9 text-ink-subtle"
            strokeWidth={1.5}
          />
        }
        toolbarEnd={
          <CreateEventAction
            isPending={createEvent.isPending}
            onCreate={createNewEvent}
          />
        }
      />
    </div>
  );
}
