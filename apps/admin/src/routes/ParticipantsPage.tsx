import { useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { useMemo, useState } from "react";
import { Link } from "react-router";

import {
  getListParticipantsQueryKey,
  useListParticipants,
  useUpdateParticipantFeedbackOptIn,
} from "../api/generated/participants";
import type { ParticipantDtoOutput } from "../api/generated/model/participantDtoOutput";
import type { ParticipantListDtoOutput } from "../api/generated/model/participantListDtoOutput";
import { JtsDataTable } from "../components/ui/JtsDataTable";
import { JtsPageHeader } from "../components/ui/JtsPageHeader";
import { apiErrorMessage } from "../lib/api";
import { usePageMeta } from "../lib/usePageMeta";

/** Minimal participant admin list with the post-event feedback WhatsApp opt-in toggle. */
export function ParticipantsPage() {
  usePageMeta(
    "Participants",
    "Participant profiles and feedback WhatsApp opt-in.",
  );

  const queryClient = useQueryClient();
  const participantsQuery = useListParticipants();
  const updateFeedbackOptIn = useUpdateParticipantFeedbackOptIn();

  const [actionError, setActionError] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);

  const rows = participantsQuery.data?.items ?? [];
  const loading = participantsQuery.isPending || participantsQuery.isFetching;
  const error = participantsQuery.isError
    ? apiErrorMessage(participantsQuery.error, "Failed to load participants.")
    : actionError;

  async function toggleOptIn(
    id: string,
    postEventFeedbackWhatsappOptIn: boolean,
  ) {
    setSavingId(id);
    setActionError(null);
    try {
      await updateFeedbackOptIn.mutateAsync({
        id,
        data: { postEventFeedbackWhatsappOptIn },
      });
      queryClient.setQueryData<ParticipantListDtoOutput>(
        getListParticipantsQueryKey(),
        (current) => {
          if (!current) {
            return current;
          }
          return {
            items: current.items.map((row) =>
              row.id === id ? { ...row, postEventFeedbackWhatsappOptIn } : row,
            ),
          };
        },
      );
    } catch (cause) {
      setActionError(
        apiErrorMessage(cause, "Failed to update feedback opt-in."),
      );
      await participantsQuery.refetch();
    } finally {
      setSavingId(null);
    }
  }

  const columns = useMemo<ColumnDef<ParticipantDtoOutput>[]>(
    () => [
      {
        accessorKey: "preferredName",
        header: "Name",
        cell: ({ row }) => (
          <Link
            to={`/admin/participants/${row.original.id}`}
            className="font-bold text-primary underline-offset-2 hover:underline"
          >
            {row.original.preferredName ?? row.original.emailNormalized}
          </Link>
        ),
      },
      {
        accessorKey: "emailNormalized",
        header: "Email",
      },
      {
        accessorKey: "phoneE164",
        header: "Phone",
        cell: ({ row }) => row.original.phoneE164 ?? "—",
      },
      {
        accessorKey: "postEventFeedbackWhatsappOptIn",
        header: "Feedback WhatsApp",
        cell: ({ row }) => (
          <label className="inline-flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={row.original.postEventFeedbackWhatsappOptIn}
              disabled={savingId === row.original.id}
              onChange={(change) => {
                void toggleOptIn(row.original.id, change.target.checked);
              }}
              aria-label={`Post-event feedback WhatsApp opt-in for ${row.original.preferredName ?? row.original.emailNormalized}`}
            />
            Opted in
          </label>
        ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps -- toggle closes over latest saver
    [savingId],
  );

  return (
    <div className="flex flex-col gap-8">
      <JtsPageHeader
        eyebrow="Operations"
        title="Participants"
        description="Toggle post-event feedback WhatsApp eligibility. Default is opted out; every change is audited."
      />

      <JtsDataTable
        title="Participants"
        rows={rows}
        columns={columns}
        getRowId={(row) => row.id}
        loading={loading}
        error={error}
        emptyTitle="No participants"
        emptyDescription="Import WordPress profiles before managing opt-in."
      />
    </div>
  );
}
