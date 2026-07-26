import { Avatar, Chip } from "@heroui/react";
import { useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import type { LucideIcon } from "lucide-react";
import {
  AtSign,
  Cake,
  Calendar,
  Check,
  ChevronLeft,
  ContactRound,
  Mail,
  MapPin,
  MessageCircle,
  Minus,
  Phone,
  UserRound,
} from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
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
import type { ParticipantEventHistoryDtoOutputItemsItemStatus } from "../api/generated/model/participantEventHistoryDtoOutputItemsItemStatus";
import type { ParticipantListDtoOutput } from "../api/generated/model/participantListDtoOutput";
import { JtsDataTable } from "../components/ui/JtsDataTable";
import { apiErrorMessage } from "../lib/api";
import { formatDateTime } from "../lib/dateTime";
import { usePageMeta } from "../lib/usePageMeta";

const backToParticipantsLinkClassName =
  "inline-flex items-center gap-1.5 self-start text-sm font-semibold text-primary";

function BackToParticipantsLink() {
  return (
    <Link to="/admin/participants" className={backToParticipantsLinkClassName}>
      <ChevronLeft aria-hidden="true" className="size-4 shrink-0" />
      Back to participants
    </Link>
  );
}

/** Quiet em dash for missing profile fields (subtle ink, never empty-looking). */
function MissingValue() {
  return <span className="text-ink-subtle">—</span>;
}

function displayText(value: string | number | null | undefined): ReactNode {
  if (value === null || value === undefined || value === "") {
    return <MissingValue />;
  }
  return String(value);
}

/** Display-only: `45_54` → `45–54`, `55_plus` → `55+`. */
function formatAgeBand(value: string | null): ReactNode {
  if (value === null || value === "") {
    return <MissingValue />;
  }
  if (value === "55_plus") {
    return "55+";
  }
  const match = /^(\d+)_(\d+)$/.exec(value);
  if (match) {
    return `${match[1]}–${match[2]}`;
  }
  return value;
}

/** Display-only: `nea_smyrni` → `Nea Smyrni`. */
function formatNeighborhood(value: string | null): ReactNode {
  if (value === null || value === "") {
    return <MissingValue />;
  }
  return value
    .split("_")
    .map((part) => part.charAt(0).toLocaleUpperCase() + part.slice(1))
    .join(" ");
}

const EVENT_STATUS_LABEL: Record<
  ParticipantEventHistoryDtoOutputItemsItemStatus,
  string
> = {
  draft: "Draft",
  scheduled: "Scheduled",
  finished: "Finished",
  cancelled: "Cancelled",
};

function eventStatusChip(
  status: ParticipantEventHistoryDtoOutputItemsItemStatus,
) {
  const color = status === "finished" ? "success" : "default";
  return (
    <Chip color={color} size="sm" variant="soft">
      <Chip.Label>{EVENT_STATUS_LABEL[status]}</Chip.Label>
    </Chip>
  );
}

function SectionOverline({
  id,
  icon: Icon,
  children,
}: {
  id: string;
  icon: LucideIcon;
  children: string;
}) {
  return (
    <h2
      id={id}
      className="mb-4 flex items-center gap-2 jts-overline text-ink-muted"
    >
      <Icon aria-hidden="true" className="size-4 shrink-0" />
      {children}
    </h2>
  );
}

function FieldRow({
  icon: Icon,
  label,
  children,
}: {
  icon: LucideIcon;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex gap-3">
      <Icon
        aria-hidden="true"
        className="mt-0.5 size-4 shrink-0 text-ink-muted"
      />
      <div className="min-w-0">
        <dt className="text-xs font-semibold uppercase tracking-caps text-ink-muted">
          {label}
        </dt>
        <dd className="text-sm text-ink">{children}</dd>
      </div>
    </div>
  );
}

/** Five static dots filled up to the 1–5 conversation-style score. */
function ConversationStyleMeter({ value }: { value: number | null }) {
  if (value === null) {
    return <MissingValue />;
  }
  const filled = Math.min(5, Math.max(1, Math.round(value)));
  return (
    <span className="inline-flex items-center gap-2">
      <span className="inline-flex items-center gap-1" aria-hidden="true">
        {Array.from({ length: 5 }, (_, index) => (
          <span
            key={index}
            className={
              index < filled
                ? "size-1.5 rounded-full bg-ink"
                : "size-1.5 rounded-full bg-border"
            }
          />
        ))}
      </span>
      <span className="tabular-nums text-ink">
        {filled}
        /5
      </span>
    </span>
  );
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
  const monogramSource =
    participant?.preferredName?.trim() ||
    participant?.emailNormalized?.trim() ||
    displayName;
  const monogram = monogramSource.charAt(0).toLocaleUpperCase() || "?";

  usePageMeta(
    participant ? displayName : "Participant",
    "Participant profile, feedback WhatsApp opt-in and event history.",
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
        cell: ({ row }) => (
          <span className="tabular-nums">
            {formatDateTime(row.original.startsAt)}
          </span>
        ),
      },
      {
        accessorKey: "status",
        header: "Status",
        cell: ({ row }) => eventStatusChip(row.original.status),
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
            <MissingValue />
          ) : (
            <Chip color="default" size="sm" variant="soft">
              <Chip.Label>Table {row.original.tableNo}</Chip.Label>
            </Chip>
          ),
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
        <BackToParticipantsLink />
      </div>
    );
  }

  const error = actionError ?? loadError;
  const optedIn = participant.postEventFeedbackWhatsappOptIn;

  return (
    <div className="flex flex-col gap-5">
      <div className="mb-3 flex flex-col gap-4">
        <BackToParticipantsLink />

        <header className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-4">
            {/* Rounded square: circle motif stays reserved for the brand mark. */}
            <Avatar
              color="default"
              variant="soft"
              size="lg"
              aria-hidden="true"
              className="size-14 shrink-0 rounded-md"
            >
              <Avatar.Fallback className="border border-border bg-surface-raised text-lg font-extrabold text-ink">
                {monogram}
              </Avatar.Fallback>
            </Avatar>
            <div className="min-w-0">
              {/* Matches JtsPageHeader's scale — this route owns its own h1 for
                  the avatar pairing, not a different title hierarchy. */}
              <h1 className="mb-0 font-display text-[1.375rem] font-extrabold text-ink after:mt-2 after:block after:h-[3px] after:w-8 after:bg-primary after:content-['']">
                {displayName}
              </h1>
              <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-ink-muted">
                <span className="inline-flex items-center gap-1.5">
                  <Mail
                    aria-hidden="true"
                    className="size-3.5 shrink-0 text-ink-subtle"
                  />
                  {participant.emailNormalized}
                </span>
                <span aria-hidden="true" className="text-ink-subtle">
                  ·
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <Phone
                    aria-hidden="true"
                    className="size-3.5 shrink-0 text-ink-subtle"
                  />
                  {participant.phoneE164 ? (
                    participant.phoneE164
                  ) : (
                    <MissingValue />
                  )}
                </span>
              </p>
            </div>
          </div>

          <Chip
            color={optedIn ? "success" : "default"}
            size="sm"
            variant="soft"
          >
            <Chip.Label>{optedIn ? "Opted in" : "Not opted in"}</Chip.Label>
          </Chip>
        </header>
      </div>

      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}

      <section
        aria-labelledby="participant-profile-heading"
        className="rounded-md border border-border bg-surface px-4 py-4"
      >
        <SectionOverline id="participant-profile-heading" icon={ContactRound}>
          Profile
        </SectionOverline>
        <dl className="grid gap-4 sm:grid-cols-2">
          <FieldRow icon={UserRound} label="Preferred name">
            {displayText(participant.preferredName)}
          </FieldRow>
          <FieldRow icon={Cake} label="Age band">
            {formatAgeBand(participant.ageBand)}
          </FieldRow>
          <FieldRow icon={MapPin} label="Neighborhood">
            {formatNeighborhood(participant.preferredNeighborhood)}
          </FieldRow>
          <FieldRow icon={MessageCircle} label="Conversation style">
            <ConversationStyleMeter value={participant.conversationStyle} />
          </FieldRow>
        </dl>
      </section>

      <section
        aria-labelledby="participant-contact-heading"
        className="rounded-md border border-border bg-surface px-4 py-4"
      >
        <SectionOverline id="participant-contact-heading" icon={Mail}>
          Contact & consent
        </SectionOverline>
        <dl className="grid gap-4 sm:grid-cols-2">
          <FieldRow icon={AtSign} label="Email">
            {participant.emailNormalized}
          </FieldRow>
          <FieldRow icon={Phone} label="Phone">
            {displayText(participant.phoneE164)}
          </FieldRow>
        </dl>

        <div className="mt-5 border-t border-border-subtle pt-4">
          <label className="inline-flex items-center gap-2 text-sm text-ink">
            <input
              type="checkbox"
              checked={optedIn}
              disabled={saving}
              onChange={(change) => {
                void toggleOptIn(change.target.checked);
              }}
              aria-label={`Post-event feedback WhatsApp opt-in for ${displayName}`}
            />
            Feedback WhatsApp opted in
          </label>
          <p className="mt-1.5 text-xs text-ink-muted">
            When on, this person may receive post-event feedback on WhatsApp.
          </p>
        </div>
      </section>

      <JtsDataTable
        title="Dinner history"
        description="Events this participant was listed on, newest first."
        rows={historyRows}
        columns={historyColumns}
        getRowId={(row) => row.eventId}
        loading={historyLoading}
        error={historyError}
        emptyTitle="No dinners yet"
        emptyDescription=""
        emptyIcon={
          <Calendar
            aria-hidden="true"
            className="size-9 text-ink-subtle"
            strokeWidth={1.5}
          />
        }
        emptyActions={
          <Link
            to="/admin/events"
            className="text-sm font-semibold text-primary"
          >
            Browse events
          </Link>
        }
      />
    </div>
  );
}
