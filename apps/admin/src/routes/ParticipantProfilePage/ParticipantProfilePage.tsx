import { Avatar, Checkbox } from "@heroui/react";
import type { LucideIcon } from "lucide-react";
import {
  Cake,
  Calendar,
  Hash,
  MapPin,
  MessageCircle,
  SlidersHorizontal,
  UserRound,
} from "lucide-react";
import { type ReactNode } from "react";
import { Link } from "react-router";

import { JtsBackLink } from "../../components/ui/JtsBackLink";
import { JtsDataTable } from "../../components/ui/JtsDataTable";
import {
  formatAgeBand,
  formatNeighborhood,
} from "../../features/participants/profileFields";
import { usePageMeta } from "../../lib/usePageMeta";

import { ContactEmail, ContactPhone } from "./ParticipantContact";
import { useParticipantProfileControls } from "./useParticipantProfileControls";

export function ParticipantProfilePage() {
  const {
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
  } = useParticipantProfileControls();

  usePageMeta(
    participant ? displayName : "Participant",
    "Participant profile, feedback WhatsApp opt-in and event history.",
  );

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
        {/* The nameplate and contact row align with the attribute grid below. */}
        <header className="flex min-w-0 flex-col gap-3">
          <div className="flex min-w-0 items-center gap-3">
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
            {/* Match the avatar height while allowing long Greek names to wrap. */}
            <div className="flex min-h-12 min-w-0 flex-col justify-center">
              {/* Match the shared page title while keeping profile actions adjacent. */}
              <h1
                id="participant-sheet-heading"
                className="jts-page-title mb-0 font-display text-[1.375rem] font-bold leading-tight text-ink"
              >
                <Hash aria-hidden="true" className="jts-page-title-mark" />
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

function BackToParticipantsLink() {
  return (
    <JtsBackLink to="/admin/participants">Back to participants</JtsBackLink>
  );
}

function displayText(value: string | number | null | undefined): ReactNode {
  if (value === null || value === undefined || value === "") {
    return <MissingValue />;
  }
  return String(value);
}

/** Quiet em dash for missing profile fields (subtle ink, never empty-looking). */
function MissingValue() {
  return <span className="text-ink-subtle">—</span>;
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
        <dt className="jts-overline text-ink-muted">{label}</dt>
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
