import { useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { useMemo, useState } from "react";
import { Link, useParams } from "react-router";

import {
  getGetParticipantQueryKey,
  getListParticipantsQueryKey,
  useGetParticipant,
  useListParticipantEvents,
  useUpdateParticipantFeedbackOptIn,
} from "../api/generated/participants";
import type { ParticipantDtoOutput } from "../api/generated/model/participantDtoOutput";
import type { ParticipantEventHistoryDtoOutputItemsItem } from "../api/generated/model/participantEventHistoryDtoOutputItemsItem";
import type { ParticipantListDtoOutput } from "../api/generated/model/participantListDtoOutput";
import { JtsDataTable } from "../components/ui/JtsDataTable";
import { JtsPageHeader } from "../components/ui/JtsPageHeader";
import { usePageMeta } from "../lib/usePageMeta";

function requestErrorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}

function displayValue(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") {
    return "—";
  }
  return String(value);
}

function formatEventDate(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/** Staff participant profile: contact fields, feedback opt-in and event history. */
export function ParticipantProfilePage() {
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

  usePageMeta(
    participant ? displayName : "Participant",
    "Participant profile, feedback WhatsApp opt-in and event history.",
  );

  const historyRows = eventsQuery.data?.items ?? [];
  const historyLoading = eventsQuery.isPending || eventsQuery.isFetching;
  const historyError = eventsQuery.isError
    ? requestErrorMessage(eventsQuery.error, "Failed to load event history.")
    : null;

  const loadError = participantQuery.isError
    ? requestErrorMessage(participantQuery.error, "Failed to load participant.")
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
        requestErrorMessage(cause, "Failed to update feedback opt-in."),
      );
      await participantQuery.refetch();
    } finally {
      setSaving(false);
    }
  }

  const historyColumns = useMemo<
    ColumnDef<ParticipantEventHistoryDtoOutputItemsItem>[]
  >(
    () => [
      {
        accessorKey: "title",
        header: "Event",
        cell: ({ row }) => (
          <Link
            to={`/admin/events/${row.original.eventId}`}
            className="font-bold text-primary underline-offset-2 hover:underline"
          >
            {row.original.title}
          </Link>
        ),
      },
      {
        accessorKey: "startsAt",
        header: "Date",
        cell: ({ row }) => formatEventDate(row.original.startsAt),
      },
      {
        accessorKey: "present",
        header: "Attendance",
        cell: ({ row }) => (row.original.present ? "Present" : "Absent"),
      },
      {
        accessorKey: "tableNo",
        header: "Table",
        cell: ({ row }) => displayValue(row.original.tableNo),
      },
      {
        accessorKey: "status",
        header: "Status",
      },
    ],
    [],
  );

  const awaitingInitial =
    (participantQuery.isPending || participantQuery.isFetching) && !participant;

  if (awaitingInitial) {
    return <p role="status">Loading participant…</p>;
  }

  if (!participant) {
    return (
      <div className="flex flex-col gap-4">
        <p role="alert">
          {loadError ?? actionError ?? "Participant not found."}
        </p>
        <Link
          to="/admin/participants"
          className="text-sm font-semibold text-primary"
        >
          Back to participants
        </Link>
      </div>
    );
  }

  const error = actionError ?? loadError;

  return (
    <div className="flex flex-col gap-8">
      <JtsPageHeader
        eyebrow="Operations"
        title={displayName}
        description="Profile details, feedback WhatsApp eligibility and events attended."
        actions={
          <Link
            to="/admin/participants"
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

      <section
        aria-labelledby="participant-info-heading"
        className="rounded-md border border-border p-4"
      >
        <h2
          id="participant-info-heading"
          className="mb-4 text-base font-extrabold text-ink"
        >
          Profile
        </h2>
        <dl className="grid gap-3 sm:grid-cols-2">
          <div>
            <dt className="text-xs font-semibold uppercase tracking-caps text-ink-muted">
              Preferred name
            </dt>
            <dd className="text-sm text-ink">
              {displayValue(participant.preferredName)}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase tracking-caps text-ink-muted">
              Email
            </dt>
            <dd className="text-sm text-ink">{participant.emailNormalized}</dd>
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase tracking-caps text-ink-muted">
              Phone
            </dt>
            <dd className="text-sm text-ink">
              {displayValue(participant.phoneE164)}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase tracking-caps text-ink-muted">
              Age band
            </dt>
            <dd className="text-sm text-ink">
              {displayValue(participant.ageBand)}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase tracking-caps text-ink-muted">
              Neighborhood
            </dt>
            <dd className="text-sm text-ink">
              {displayValue(participant.preferredNeighborhood)}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase tracking-caps text-ink-muted">
              Conversation style
            </dt>
            <dd className="text-sm text-ink">
              {displayValue(participant.conversationStyle)}
            </dd>
          </div>
        </dl>

        <label className="mt-5 inline-flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={participant.postEventFeedbackWhatsappOptIn}
            disabled={saving}
            onChange={(change) => {
              void toggleOptIn(change.target.checked);
            }}
            aria-label={`Post-event feedback WhatsApp opt-in for ${displayName}`}
          />
          Feedback WhatsApp opted in
        </label>
      </section>

      <JtsDataTable
        title="Event history"
        description="Events this participant attended, newest first."
        rows={historyRows}
        columns={historyColumns}
        getRowId={(row) => row.eventId}
        loading={historyLoading}
        error={historyError}
        emptyTitle="No events yet"
        emptyDescription="This participant has not been added to any event attendance list."
      />
    </div>
  );
}
