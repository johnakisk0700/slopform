import { Button, Input } from "@heroui/react";
import type { ColumnDef } from "@tanstack/react-table";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { Link } from "react-router";

import { JtsDataTable } from "../components/ui/JtsDataTable";
import { JtsPageHeader } from "../components/ui/JtsPageHeader";
import { eventListSchema, type EventSummary } from "../features/event/schema";
import { api } from "../lib/api";
import { usePageMeta } from "../lib/usePageMeta";

const EVENTS_PATH = "/v1/events";

const columns: ColumnDef<EventSummary>[] = [
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

/** Minimal staff CRUD list for stub events (WP1). */
export function EventsPage() {
  usePageMeta("Events", "Stub events, attendance and table assignments.");

  const [rows, setRows] = useState<EventSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const payload = eventListSchema.parse(await api(EVENTS_PATH));
      setRows(payload.items);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Failed to load events.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [load]);

  async function onCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await api(EVENTS_PATH, {
        method: "POST",
        body: {
          title,
          startsAt: new Date(startsAt).toISOString(),
        },
      });
      setTitle("");
      setStartsAt("");
      await load();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Failed to create event.",
      );
    } finally {
      setSaving(false);
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
        <Button type="submit" isDisabled={saving}>
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
