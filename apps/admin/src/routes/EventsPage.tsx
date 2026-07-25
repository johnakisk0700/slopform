import { Button, Input } from "@heroui/react";
import type { ColumnDef } from "@tanstack/react-table";
import { type FormEvent, useState } from "react";
import { Link } from "react-router";

import { useCreateEvent, useListEvents } from "../api/generated/events";
import type { EventListDtoOutputItemsItem } from "../api/generated/model/eventListDtoOutputItemsItem";
import { JtsDataTable } from "../components/ui/JtsDataTable";
import { JtsPageHeader } from "../components/ui/JtsPageHeader";
import { usePageMeta } from "../lib/usePageMeta";

const columns: ColumnDef<EventListDtoOutputItemsItem>[] = [
  {
    accessorKey: "title",
    header: "Event",
    cell: ({ row }) => (
      <Link
        to={`/admin/events/${row.original.id}`}
        className="font-bold text-primary underline-offset-2 hover:underline"
      >
        {row.original.title}
      </Link>
    ),
  },
  {
    accessorKey: "startsAt",
    header: "Starts",
    cell: ({ row }) =>
      new Date(row.original.startsAt).toLocaleString("en-GB", {
        dateStyle: "medium",
        timeStyle: "short",
      }),
  },
  {
    accessorKey: "status",
    header: "Status",
  },
  {
    id: "attendance",
    header: "Present / total",
    cell: ({ row }) =>
      `${row.original.presentCount} / ${row.original.attendeeCount}`,
  },
];

function requestErrorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}

/** Minimal staff CRUD list for stub events (WP1). */
export function EventsPage() {
  usePageMeta("Events", "Stub events, attendance and table assignments.");

  const eventsQuery = useListEvents();
  const createEvent = useCreateEvent();

  const [title, setTitle] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);

  const rows = eventsQuery.data?.items ?? [];
  const loading = eventsQuery.isPending || eventsQuery.isFetching;
  const error = eventsQuery.isError
    ? requestErrorMessage(eventsQuery.error, "Failed to load events.")
    : actionError;

  async function onCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setActionError(null);
    try {
      await createEvent.mutateAsync({
        data: {
          title,
          startsAt: new Date(startsAt).toISOString(),
        },
      });
      setTitle("");
      setStartsAt("");
      await eventsQuery.refetch();
    } catch (cause) {
      setActionError(requestErrorMessage(cause, "Failed to create event."));
    }
  }

  return (
    <div className="flex flex-col gap-8">
      <JtsPageHeader
        eyebrow="Operations"
        title="Events"
        description="Create stub events, edit attendance and finish them before launching feedback."
      />

      <form
        onSubmit={onCreate}
        className="flex flex-wrap items-end gap-3 rounded-md border border-border p-4"
      >
        <div className="grid min-w-[16rem] flex-1 gap-1.5">
          <label htmlFor="new-event-title" className="text-sm font-semibold">
            Title
          </label>
          <Input
            id="new-event-title"
            value={title}
            onChange={(change) => setTitle(change.target.value)}
            required
          />
        </div>
        <div className="grid min-w-[14rem] gap-1.5">
          <label
            htmlFor="new-event-starts-at"
            className="text-sm font-semibold"
          >
            Starts at
          </label>
          <Input
            id="new-event-starts-at"
            type="datetime-local"
            value={startsAt}
            onChange={(change) => setStartsAt(change.target.value)}
            required
          />
        </div>
        <Button type="submit" isDisabled={createEvent.isPending}>
          Create event
        </Button>
      </form>

      <JtsDataTable
        title="Events"
        rows={rows}
        columns={columns}
        getRowId={(row) => row.id}
        loading={loading}
        error={error}
        emptyTitle="No events yet"
        emptyDescription="Create a stub event to start attendance."
      />
    </div>
  );
}
