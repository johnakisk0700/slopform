import { Checkbox, SearchField } from "@heroui/react";
import { useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { Search, Users, X } from "lucide-react";
import { useMemo, useState } from "react";

import {
  getListParticipantsQueryKey,
  useListParticipants,
  useUpdateParticipantFeedbackOptIn,
} from "../api/generated/participants";
import type { ParticipantDtoOutput } from "../api/generated/model/participantDtoOutput";
import type { ParticipantListDtoOutput } from "../api/generated/model/participantListDtoOutput";
import { ParticipantIdentity } from "../components/admin/participants/ParticipantIdentity";
import { JtsDataTable } from "../components/ui/JtsDataTable";
import { JtsPageHeader } from "../components/ui/JtsPageHeader";
import { matchesParticipantQuery } from "../features/participants/search";
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
  const [query, setQuery] = useState("");

  const allRows = useMemo(
    () => participantsQuery.data?.items ?? [],
    [participantsQuery.data?.items],
  );
  const rows = useMemo(
    () => allRows.filter((row) => matchesParticipantQuery(row, query)),
    [allRows, query],
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

  return (
    <div className="flex flex-col gap-6">
      <JtsPageHeader
        eyebrow="Operations"
        title="Participants"
        description="Toggle post-event feedback WhatsApp eligibility. Default is opted out; every change is audited."
      />

      <JtsDataTable
        title="Participants"
        description={
          query.trim() === ""
            ? null
            : `${rows.length} of ${allRows.length} match “${query.trim()}”.`
        }
        rows={rows}
        columns={columns}
        getRowId={(row) => row.id}
        loading={loading}
        error={error}
        paginator
        pageSize={25}
        rowsPerPageOptions={[25, 50, 100]}
        emptyTitle={
          query.trim() === "" ? "No participants" : "Nobody matches that"
        }
        emptyDescription={
          query.trim() === ""
            ? "Import WordPress profiles before managing opt-in."
            : "Try a different name, email or phone."
        }
        emptyIcon={
          <Users
            aria-hidden="true"
            className="size-9 text-ink-subtle"
            strokeWidth={1.5}
          />
        }
        toolbarEnd={
          <SearchField
            aria-label="Search participants"
            value={query}
            onChange={setQuery}
            className="max-sm:w-full"
          >
            <SearchField.Group>
              <SearchField.SearchIcon>
                <Search aria-hidden="true" className="size-4" />
              </SearchField.SearchIcon>
              <SearchField.Input placeholder="Name, email or phone…" />
              <SearchField.ClearButton>
                <X aria-hidden="true" className="size-4" />
              </SearchField.ClearButton>
            </SearchField.Group>
          </SearchField>
        }
      />
    </div>
  );
}
