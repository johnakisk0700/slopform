import { useMemo } from "react";

import { useCreateEvent, useListEvents } from "../../api/generated/events";
import { apiErrorMessage } from "../../lib/api";

export function useEventsControls() {
  const eventsQuery = useListEvents();

  const createEvent = useCreateEvent();

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
    : null;

  async function createNewEvent(details: { title: string; startsAt: string }) {
    await createEvent.mutateAsync({
      data: {
        title: details.title,
        startsAt: new Date(details.startsAt).toISOString(),
      },
    });
    await eventsQuery.refetch();
  }
  return { createEvent, rows, loading, error, createNewEvent };
}
