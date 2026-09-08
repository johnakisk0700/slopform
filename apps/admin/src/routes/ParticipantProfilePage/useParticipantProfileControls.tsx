import { Chip } from "@heroui/react";
import { useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { Check, Minus } from "lucide-react";
import { useState } from "react";
import { Link, useParams } from "react-router";

import type { ParticipantDtoOutput } from "../../api/generated/model/participantDtoOutput";
import type { ParticipantEventHistoryDtoOutputItemsItem } from "../../api/generated/model/participantEventHistoryDtoOutputItemsItem";
import type { ParticipantListDtoOutput } from "../../api/generated/model/participantListDtoOutput";
import {
  getGetParticipantQueryKey,
  getListParticipantsQueryKey,
  useGetParticipant,
  useListParticipantEvents,
  useUpdateParticipantFeedbackOptIn,
} from "../../api/generated/participants";
import { EventStatusChip } from "../../components/admin/events/EventStatusChip";
import { VenuePill } from "../../components/admin/events/VenuePill";
import { participantMonogram } from "../../features/participants/profileFields";
import { apiErrorMessage } from "../../lib/api";
import { formatDateTime } from "../../lib/dateTime";

export function useParticipantProfileControls() {
  const { id: participantId = "" } = useParams();

  const queryClient = useQueryClient();

  const participantQuery = useGetParticipant(participantId, {
    query: { enabled: participantId.length > 0 },
  });

  const eventsQuery = useListParticipantEvents(participantId, {
    query: { enabled: participantId.length > 0 },
  });

  const updateFeedbackOptIn = useUpdateParticipantFeedbackOptIn();

  const [actionError, setActionError] = useState<string | null>(null);

  const [saving, setSaving] = useState(false);

  const participant = participantQuery.data;

  const displayName =
    participant?.preferredName ?? participant?.emailNormalized ?? "Participant";

  const monogram = participantMonogram(
    participant?.preferredName ?? null,
    participant?.emailNormalized ?? displayName,
  );

  const historyRows = eventsQuery.data?.items ?? [];

  const historyLoading = eventsQuery.isPending || eventsQuery.isFetching;

  const historyError = eventsQuery.isError
    ? apiErrorMessage(eventsQuery.error, "Failed to load event history.")
    : null;

  const loadError = participantQuery.isError
    ? apiErrorMessage(participantQuery.error, "Failed to load participant.")
    : null;

  async function toggleOptIn(postEventFeedbackWhatsappOptIn: boolean) {
    if (!participant) {
      return;
    }
    setSaving(true);
    setActionError(null);
    try {
      const updated = await updateFeedbackOptIn.mutateAsync({
        id: participant.id,
        data: { postEventFeedbackWhatsappOptIn },
      });
      queryClient.setQueryData<ParticipantDtoOutput>(
        getGetParticipantQueryKey(participant.id),
        updated,
      );
      queryClient.setQueryData<ParticipantListDtoOutput>(
        getListParticipantsQueryKey(),
        (current) => {
          if (!current) {
            return current;
          }
          return {
            items: current.items.map((row) =>
              row.id === participant.id
                ? { ...row, postEventFeedbackWhatsappOptIn }
                : row,
            ),
          };
        },
      );
    } catch (cause) {
      setActionError(
        apiErrorMessage(cause, "Failed to update feedback opt-in."),
      );
      await participantQuery.refetch();
    } finally {
      setSaving(false);
    }
  }

  const awaitingInitial =
    (participantQuery.isPending || participantQuery.isFetching) && !participant;
  return {
    actionError,
    saving,
    participant,
    displayName,
    monogram,
    historyRows,
    historyLoading,
    historyError,
    loadError,
    toggleOptIn,
    historyColumns,
    awaitingInitial,
  };
}

const historyColumns: ColumnDef<ParticipantEventHistoryDtoOutputItemsItem>[] = [
  {
    accessorKey: "title",
    header: "Event",
    cell: ({ row }) => (
      <div className="grid min-w-0 gap-1.5">
        <Link
          to={`/admin/events/${row.original.eventId}`}
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
    header: "Date",
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
    accessorKey: "present",
    header: "Attendance",
    cell: ({ row }) =>
      row.original.present ? (
        <span className="inline-flex items-center gap-1.5 text-sm text-ink">
          <Check
            aria-hidden="true"
            className="size-3.5 shrink-0 text-ink-muted"
          />
          Attended
        </span>
      ) : (
        <span className="inline-flex items-center gap-1.5 text-sm text-ink">
          <Minus
            aria-hidden="true"
            className="size-3.5 shrink-0 text-ink-muted"
          />
          No-show
        </span>
      ),
  },
  {
    accessorKey: "tableNo",
    header: "Table",
    cell: ({ row }) =>
      row.original.tableNo === null ? (
        <span className="text-ink-subtle">—</span>
      ) : (
        <Chip color="default" size="sm" variant="soft">
          <Chip.Label>Table {row.original.tableNo}</Chip.Label>
        </Chip>
      ),
  },
];
