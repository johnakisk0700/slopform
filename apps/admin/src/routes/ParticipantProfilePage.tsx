import { Avatar, Button, Checkbox, Chip } from "@heroui/react";
import { useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import type { LucideIcon } from "lucide-react";
import {
  AtSign,
  Cake,
  Calendar,
  Check,
  Copy,
  MapPin,
  MessageCircle,
  Minus,
  Phone,
  SlidersHorizontal,
  UserRound,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
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
import { EventStatusChip } from "../components/admin/events/EventStatusChip";
import { VenuePill } from "../components/admin/events/VenuePill";
import { JtsBackLink } from "../components/ui/JtsBackLink";
import { JtsDataTable } from "../components/ui/JtsDataTable";
import {
  formatAgeBand,
  formatNeighborhood,
  participantMonogram,
} from "../features/participants/profileFields";
import { apiErrorMessage } from "../lib/api";
import { formatDateTime } from "../lib/dateTime";
import { usePageMeta } from "../lib/usePageMeta";

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

/** Long enough to notice, short enough not to linger — same beat as CopyableId. */
const COPIED_FEEDBACK_MS = 1_500;

function useCopyFeedback() {
  const [copied, setCopied] = useState(false);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(resetTimerRef.current), []);

  async function copyValue(value: string): Promise<void> {
    clearTimeout(resetTimerRef.current);
    try {
      await navigator.clipboard?.writeText(value);
      setCopied(true);
      resetTimerRef.current = setTimeout(
        () => setCopied(false),
        COPIED_FEEDBACK_MS,
      );
    } catch {
      // Clipboard can be unavailable on insecure LAN origins; leave the UI calm.
    }
  }

  return { copied, copyValue };
}

function BackToParticipantsLink() {
  return (
    <JtsBackLink to="/admin/participants">Back to participants</JtsBackLink>
  );
}

/**
 * The contact pill, and the page's one rule about colour.
 *
 * **The sheet spends one hue, and it is `primary`** — the links, the pill
 * hovers and five of the six title dots. Every glyph that only labels a field
 * is neutral ink. Two earlier cuts each got half of this: the first painted
 * the email and phone *values* in the accent, the second moved that accent
 * onto the leading glyphs and spread it to all seven icons on the card. Both
 * left copper and primary sharing one screen with nothing to tell them apart
 * — near-neighbours in the warm palettes, so the eye read the pair as an
 * accident rather than as two meanings. Copper stays what tokens.css says it
 * is: occasional emphasis (the Overview aside, the sixth title dot), never a
 * page's icon ink.
 *
 * The leading glyph is what earlier drafts were missing rather than the
 * colour: every other labelled field here is icon-led, so a bare pill had
 * nothing to belong to. `AtSign` / `Phone` are the same icons — now in the
 * same `ink-subtle` — the feedback pane's Respondent header spends on these
 * two fields.
 *
 * The fill is `surface-sunken` over `border`, the recipe VenuePill and
 * CopyableId share, so the pill sits in the card instead of floating over it.
 */
const contactPillClassName =
  "inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-surface-sunken px-2 py-0.5 text-sm text-ink transition-colors hover:border-primary";

function ContactEmail({ email }: { email: string }) {
  const { copied, copyValue } = useCopyFeedback();

  return (
    <span title={email} className="inline-flex max-w-full">
      <Button
        variant="ghost"
        onPress={() => void copyValue(email)}
        aria-label={copied ? "Copied email" : "Copy email"}
        className={`${contactPillClassName} h-auto min-h-0 cursor-pointer font-normal hover:bg-surface-sunken hover:text-primary data-[hovered=true]:bg-surface-sunken`}
      >
        <AtSign
          aria-hidden="true"
          className="size-3.5 shrink-0 text-ink-subtle"
        />
        <span className="truncate">{email}</span>
        {copied ? (
          <Check aria-hidden="true" className="size-3.5 shrink-0 text-primary" />
        ) : (
          <Copy
            aria-hidden="true"
            className="size-3.5 shrink-0 text-ink-subtle"
          />
        )}
      </Button>
    </span>
  );
}

/**
 * The number dials via `tel:` (mobile), and a quiet copy control sits beside it
 * for desktop paste jobs — two affordances in one pill, so the hover states
 * stay on the parts rather than on the whole.
 */
function ContactPhone({ phone }: { phone: string }) {
  const { copied, copyValue } = useCopyFeedback();

  return (
    <span className={contactPillClassName}>
      <Phone aria-hidden="true" className="size-3.5 shrink-0 text-ink-subtle" />
      <a
        href={`tel:${phone}`}
        className="truncate tabular-nums underline-offset-2 transition-colors hover:text-primary hover:underline"
      >
        {phone}
      </a>
      <span title={phone} className="inline-flex shrink-0">
        <Button
          isIconOnly
          variant="ghost"
          size="sm"
          onPress={() => void copyValue(phone)}
          aria-label={copied ? "Copied phone" : "Copy phone"}
          className="size-6 min-h-6 min-w-6 shrink-0 text-ink-subtle hover:bg-transparent hover:text-primary data-[hovered=true]:bg-transparent"
        >
          {copied ? (
            <Check aria-hidden="true" className="size-3.5 text-primary" />
          ) : (
            <Copy aria-hidden="true" className="size-3.5" />
          )}
        </Button>
      </span>
    </span>
  );
}

/** Label-over-value cell for the character-sheet attribute grid. */
function SheetAttribute({
  icon: Icon,
  label,
  children,
}: {
  icon: LucideIcon;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 gap-2.5">
      {/* Icon and label are one unit, so they share one ink: the glyph only
          repeats what the caps line already says. */}
      <Icon
        aria-hidden="true"
        className="mt-0.5 size-4 shrink-0 text-ink-muted"
      />
      <div className="min-w-0">
        <dt className="text-xs font-semibold uppercase tracking-caps text-ink-muted">
          {label}
        </dt>
        <dd className="mt-1 text-sm text-ink">{children}</dd>
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
  const monogram = participantMonogram(
    participant?.preferredName ?? null,
    participant?.emailNormalized ?? displayName,
  );

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
    <div className="flex flex-col gap-6">
      <BackToParticipantsLink />

      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}

      {/* Character sheet: nameplate + attributes. Preferences and dinner
          history sit below as their own sections. */}
      <section
        aria-labelledby="participant-sheet-heading"
        className="rounded-md border border-border bg-surface px-4 py-4"
      >
        {/* Two bands, not three columns. The nameplate is one 48px band —
            monogram beside a name-and-mark cluster boxed to the very same
            height — and the contacts are a second band below it, starting at
            the card's left rail like the attribute grid does. The first cut
            stacked name, mark and pills in a column taller than the avatar,
            so the monogram hung against dead space and nothing on the card
            shared an edge with anything else. */}
        <header className="flex min-w-0 flex-col gap-3">
          <div className="flex min-w-0 items-center gap-3">
            {/* Rounded square: circle motif stays reserved for the brand mark. */}
            <Avatar
              color="default"
              variant="soft"
              size="lg"
              aria-hidden="true"
              className="size-12 shrink-0 rounded-md border border-border"
            >
              <Avatar.Fallback className="bg-surface-raised text-base font-extrabold text-ink">
                {monogram}
              </Avatar.Fallback>
            </Avatar>
            {/* `min-h-12` is the avatar's height and `justify-center` centres
                the cluster in it: the name keeps its mark 8px away — the mark
                belongs to the name, not to the box — while the pair reads as
                the monogram's exact twin. `min-h` rather than `h` so a name
                that wraps grows the band instead of spilling out of it, and
                `leading-tight` rather than `leading-none` because a two-line
                Greek name at narrow widths sets its own descenders against
                the next line's ascenders. */}
            <div className="flex min-h-12 min-w-0 flex-col justify-center">
              {/* Same display scale and the same six-dot mark JtsPageHeader
                  gives a title — this h1 is the route's, it just happens to
                  sit beside the avatar. Opt-in lives in Preferences. */}
              <h1
                id="participant-sheet-heading"
                className="jts-title-mark mb-0 font-display text-[1.375rem] font-extrabold leading-tight text-ink"
              >
                {displayName}
              </h1>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <ContactEmail email={participant.emailNormalized} />
            {participant.phoneE164 ? (
              <ContactPhone phone={participant.phoneE164} />
            ) : null}
          </div>
        </header>

        <dl className="mt-4 grid gap-x-6 gap-y-4 border-t border-border-subtle pt-4 sm:grid-cols-2 lg:grid-cols-4">
          <SheetAttribute icon={UserRound} label="Preferred name">
            {displayText(participant.preferredName)}
          </SheetAttribute>
          <SheetAttribute icon={Cake} label="Age band">
            {displayText(formatAgeBand(participant.ageBand))}
          </SheetAttribute>
          <SheetAttribute icon={MapPin} label="Neighborhood">
            {displayText(formatNeighborhood(participant.preferredNeighborhood))}
          </SheetAttribute>
          <SheetAttribute icon={MessageCircle} label="Conversation style">
            <ConversationStyleMeter value={participant.conversationStyle} />
          </SheetAttribute>
        </dl>
      </section>

      <section
        aria-labelledby="participant-preferences-heading"
        className="rounded-md border border-border bg-surface px-4 py-4"
      >
        <h2
          id="participant-preferences-heading"
          className="mb-3 flex items-center gap-2 jts-overline text-ink-muted"
        >
          <SlidersHorizontal
            aria-hidden="true"
            className="size-4 shrink-0 text-ink-muted"
          />
          Preferences
        </h2>
        {/* HeroUI's Checkbox, as on the participants list: the raw
            `<input type="checkbox">` this replaces was painted by the OS
            accent colour, so the same opt-in was themed in the table and
            system-pink on the profile — the one control on screen belonging to
            no palette. */}
        <Checkbox
          isSelected={optedIn}
          isDisabled={saving}
          onChange={(checked) => {
            void toggleOptIn(checked);
          }}
        >
          <Checkbox.Content>
            <Checkbox.Control>
              <Checkbox.Indicator />
            </Checkbox.Control>
            <span className="text-sm">Feedback WhatsApp opted in</span>
          </Checkbox.Content>
        </Checkbox>
        <p className="mt-1.5 text-xs text-ink-muted">
          When on, this person may receive post-event feedback on WhatsApp.
        </p>
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
