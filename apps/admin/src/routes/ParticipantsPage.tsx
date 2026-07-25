import type { ColumnDef } from "@tanstack/react-table";
import { useCallback, useEffect, useMemo, useState } from "react";

import { JtsDataTable } from "../components/ui/JtsDataTable";
import { JtsPageHeader } from "../components/ui/JtsPageHeader";
import {
  participantListSchema,
  type Participant,
} from "../features/participant/schema";
import { api } from "../lib/api";
import { usePageMeta } from "../lib/usePageMeta";

const PARTICIPANTS_PATH = "/v1/participants";

/** Minimal participant admin list with the post-event feedback WhatsApp opt-in toggle. */
export function ParticipantsPage() {
  usePageMeta(
    "Participants",
    "Participant profiles and feedback WhatsApp opt-in.",
  );

  const [rows, setRows] = useState<Participant[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const payload = participantListSchema.parse(await api(PARTICIPANTS_PATH));
      setRows(payload.items);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Failed to load participants.",
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

  async function toggleOptIn(
    id: string,
    postEventFeedbackWhatsappOptIn: boolean,
  ) {
    setSavingId(id);
    setError(null);
    try {
      await api(`${PARTICIPANTS_PATH}/${id}/feedback-whatsapp-opt-in`, {
        method: "PATCH",
        body: { postEventFeedbackWhatsappOptIn },
      });
      setRows((current) =>
        current.map((row) =>
          row.id === id ? { ...row, postEventFeedbackWhatsappOptIn } : row,
        ),
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Failed to update feedback opt-in.",
      );
      await load();
    } finally {
      setSavingId(null);
    }
  }

  const columns = useMemo<ColumnDef<Participant>[]>(
    () => [
      {
        accessorKey: "preferredName",
        header: "Name",
        cell: ({ row }) =>
          row.original.preferredName ?? row.original.emailNormalized,
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
