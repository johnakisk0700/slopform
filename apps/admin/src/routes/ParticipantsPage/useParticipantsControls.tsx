import { Checkbox } from "@heroui/react";
import { useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { useMemo, useState } from "react";

import type { ParticipantDtoOutput } from "../../api/generated/model/participantDtoOutput";
import type { ParticipantListDtoOutput } from "../../api/generated/model/participantListDtoOutput";
import {
  getListParticipantsQueryKey,
  useListParticipants,
  useUpdateParticipantFeedbackOptIn,
} from "../../api/generated/participants";
import { ParticipantIdentity } from "../../components/admin/participants/ParticipantIdentity";
import { matchesParticipantQuery } from "../../features/participants/search";
import { apiErrorMessage } from "../../lib/api";

export function useParticipantsControls() {
  const queryClient = useQueryClient();

  const participantsQuery = useListParticipants();

  const updateFeedbackOptIn = useUpdateParticipantFeedbackOptIn();

  const [actionError, setActionError] = useState<string | null>(null);

  const [savingId, setSavingId] = useState<string | null>(null);

  const [query, setQuery] = useState("");

  const rows = useMemo(
    () =>
      (participantsQuery.data?.items ?? []).filter((row) =>
        matchesParticipantQuery(row, query),
      ),
    [participantsQuery.data?.items, query],
  );

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
        header: "Participant",
        cell: ({ row }) => (
          <ParticipantIdentity
            preferredName={row.original.preferredName}
            emailNormalized={row.original.emailNormalized}
            to={`/admin/participants/${row.original.id}`}
          />
        ),
      },
      {
        accessorKey: "phoneE164",
        header: "Phone",
        cell: ({ row }) =>
          row.original.phoneE164 ?? <span className="text-ink-subtle">—</span>,
      },
      {
        accessorKey: "postEventFeedbackWhatsappOptIn",
        header: "Feedback WhatsApp",
        meta: { align: "end" },
        cell: ({ row }) => (
          <div className="flex justify-end">
            <Checkbox
              isSelected={row.original.postEventFeedbackWhatsappOptIn}
              isDisabled={savingId === row.original.id}
              onChange={(optedIn) => {
                void toggleOptIn(row.original.id, optedIn);
              }}
            >
              <Checkbox.Content>
                <Checkbox.Control>
                  <Checkbox.Indicator />
                </Checkbox.Control>
                <span className="text-sm">
                  {row.original.postEventFeedbackWhatsappOptIn
                    ? "Opted in"
                    : "Opted out"}
                </span>
              </Checkbox.Content>
            </Checkbox>
          </div>
        ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps -- toggle closes over latest saver
    [savingId],
  );
  return { participantsQuery, query, setQuery, rows, loading, error, columns };
}
