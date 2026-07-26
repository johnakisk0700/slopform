import { Avatar, Button } from "@heroui/react";
import { clsx } from "clsx";
import type { LucideIcon } from "lucide-react";
import {
  BotMessageSquare,
  Hand,
  Hourglass,
  ListChecks,
  MessageSquareQuote,
  PanelRight,
  PenOff,
  SlidersHorizontal,
  SquareX,
  StickyNote,
  UserRound,
} from "lucide-react";
import { useId, type ReactNode } from "react";
import { Link } from "react-router";

import type { AddFeedbackConversationNoteDtoNoteType } from "../../../api/generated/model/addFeedbackConversationNoteDtoNoteType";
import type { FeedbackConversationDetailDtoOutput } from "../../../api/generated/model/feedbackConversationDetailDtoOutput";
import type { FeedbackConversationResultsDtoOutput } from "../../../api/generated/model/feedbackConversationResultsDtoOutput";
import { goalProgress } from "../../../features/feedback/conversationView";
import {
  goalStatusBadge,
  isUnresolvedParticipant,
  noteTypeLabel,
  participantLabel,
  questionLabel,
  reviewStatusBadge,
  staffOriginBadge,
  type FeedbackBadge,
} from "../../../features/feedback/labels";
import { AddNoteAction } from "./AddNoteAction";
import { ConfirmAction } from "./ConfirmAction";
import { FeedbackBadges } from "./FeedbackBadges";

interface ConversationDetailsProps {
  conversation: FeedbackConversationDetailDtoOutput;
  /** The campaign's event, for the note subject picker's D16 candidates. */
  eventId: string;
  results: FeedbackConversationResultsDtoOutput | undefined;
  resultsLoading: boolean;
  resultsError: string | null;
  onTakeOver: () => Promise<void>;
  onResumeBot: () => Promise<void>;
  onClose: () => Promise<void>;
  onNoteReviewChange: (
    noteId: string,
    status: "new" | "dismissed",
  ) => Promise<void>;
  onAddNote: (input: {
    noteType: AddFeedbackConversationNoteDtoNoteType;
    text: string;
    subjectParticipantId?: string;
  }) => Promise<void>;
  pendingAction: "take-over" | "resume-bot" | "close" | null;
  noteUpdatePending: boolean;
  addNotePending: boolean;
}

/**
 * One section of the pane: a tracked micro-caps label with a 16px muted stroke
 * icon, matching the participant profile's section grammar so the two staff
 * screens read as the same product. Sections are separated by a hairline and
 * carry their own interior treatment rather than repeating one grey box.
 */
function DetailSection({
  icon: Icon,
  title,
  action,
  children,
}: {
  icon: LucideIcon;
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      className="border-t border-border-subtle px-4 py-4 first:border-t-0"
    >
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3
          id={headingId}
          className="flex items-center gap-2 jts-overline text-ink-muted"
        >
          <Icon aria-hidden="true" className="size-4 shrink-0" />
          {title}
        </h3>
        {action}
      </div>
      {children}
    </section>
  );
}

/**
 * Quiet empty state: one muted icon beside one muted sentence. The icon is
 * never the section's own header glyph — an icon that repeats inside its own
 * section has stopped carrying information.
 */
function SectionEmpty({
  icon: Icon,
  children,
}: {
  icon: LucideIcon;
  children: string;
}) {
  return (
    <p className="flex items-start gap-2 text-sm text-ink-muted">
      <Icon
        aria-hidden="true"
        className="mt-0.5 size-4 shrink-0 text-ink-subtle"
        strokeWidth={1.5}
      />
      {children}
    </p>
  );
}

/**
 * The right pane: who this conversation is with, what it has produced, and what
 * an operator may do about it.
 *
 * Every control is gated on the capability flags the backend publishes for
 * this conversation — a STOP-closed thread simply reports no capabilities and
 * the whole action section disappears, with no client-side rule deciding that.
 * «Add note» is the one exception, and deliberately so: writing down what you
 * learned is not steering the conversation, so it stays available after the
 * thread closes.
 */
export function ConversationDetails({
  conversation,
  eventId,
  results,
  resultsLoading,
  resultsError,
  onTakeOver,
  onResumeBot,
  onClose,
  onNoteReviewChange,
  onAddNote,
  pendingAction,
  noteUpdatePending,
  addNotePending,
}: ConversationDetailsProps) {
  const headingId = useId();
  const progress = goalProgress(conversation.goals);
  const capabilities = conversation.capabilities;
  const hasAnyAction =
    capabilities.canTakeOver ||
    capabilities.canResumeBot ||
    capabilities.canClose;

  const name = participantLabel(conversation.respondentDisplayName);
  const unresolved = isUnresolvedParticipant(
    conversation.respondentDisplayName,
  );
  const monogram = unresolved ? "?" : name.charAt(0).toLocaleUpperCase();
  const answers = results?.answers ?? [];
  const notes = results?.notes ?? [];

  return (
    <section
      aria-labelledby={headingId}
      className="flex max-h-[78vh] min-h-0 flex-col overflow-hidden rounded-md border border-border bg-surface"
    >
      <header className="border-b border-border px-4 py-3">
        <h2
          id={headingId}
          className="flex items-center gap-2 jts-overline text-ink-muted"
        >
          <PanelRight aria-hidden="true" className="size-4 shrink-0" />
          Details
        </h2>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <DetailSection icon={UserRound} title="Respondent">
          <div className="flex items-center gap-3">
            {/* Rounded square: the circle motif stays with the brand mark.
                Neutral fill, as on the participant profile — the accent is for
                interactive emphasis, not for decorating an initial. */}
            <Avatar
              color="default"
              variant="soft"
              size="md"
              aria-hidden="true"
              className="size-10 shrink-0 rounded-md"
            >
              <Avatar.Fallback className="border border-border bg-surface-raised font-extrabold text-ink">
                {monogram}
              </Avatar.Fallback>
            </Avatar>
            <div className="min-w-0">
              {/* An unresolved id (D18) has no profile to open, so it stays
                  plain italic text rather than a link to nothing. */}
              {unresolved ? (
                <p className="truncate text-sm font-bold text-ink italic">
                  {name}
                </p>
              ) : (
                <Link
                  to={`/admin/participants/${conversation.respondentParticipantId}`}
                  className="block truncate text-sm font-bold text-primary underline-offset-2 hover:underline"
                >
                  {name}
                </Link>
              )}
              <p className="truncate text-xs text-ink-muted">
                {conversation.phoneAtLaunch}
              </p>
            </div>
          </div>
        </DetailSection>

        <DetailSection icon={ListChecks} title="Goal progress">
          <p className="mb-3 text-sm text-ink-muted">
            <strong className="font-bold text-ink tabular-nums">
              {progress.answered}
            </strong>{" "}
            answered,{" "}
            <strong className="font-bold text-ink tabular-nums">
              {progress.skipped}
            </strong>{" "}
            skipped,{" "}
            <strong className="font-bold text-ink tabular-nums">
              {progress.outstanding}
            </strong>{" "}
            outstanding of {progress.total}.
          </p>
          <ul className="space-y-1.5">
            {conversation.goals.map((goal) => (
              <li
                key={goal.key}
                className="flex items-center justify-between gap-2"
              >
                <span className="text-sm text-ink">
                  {questionLabel(goal.key)}
                </span>
                <FeedbackBadges badges={[goalStatusBadge(goal.status)]} />
              </li>
            ))}
          </ul>
        </DetailSection>

        <DetailSection icon={MessageSquareQuote} title="Answers">
          {resultsError ? (
            <p role="alert" className="text-sm text-danger">
              {resultsError}
            </p>
          ) : resultsLoading && results === undefined ? (
            <p role="status" className="text-sm text-ink-muted">
              Loading answers…
            </p>
          ) : answers.length === 0 ? (
            <SectionEmpty icon={Hourglass}>
              Nothing extracted from this conversation yet.
            </SectionEmpty>
          ) : (
            <ul className="space-y-2">
              {answers.map((answer) => (
                <li
                  key={answer.id}
                  className="rounded-md border border-border-subtle bg-surface-sunken px-3 py-2"
                >
                  <p className="jts-overline text-ink-muted">
                    {questionLabel(answer.questionKey)}
                  </p>
                  <p
                    className={clsx(
                      "mt-0.5 text-sm text-ink",
                      answer.valueInt === null &&
                        isUnresolvedParticipant(answer.subjectDisplayName) &&
                        "italic",
                    )}
                  >
                    {answer.valueInt === null
                      ? participantLabel(answer.subjectDisplayName)
                      : `${answer.valueInt} / 5`}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </DetailSection>

        <DetailSection
          icon={StickyNote}
          title="Notes"
          action={
            <AddNoteAction
              eventId={eventId}
              respondentParticipantId={conversation.respondentParticipantId}
              isDisabled={eventId === ""}
              isPending={addNotePending}
              onAdd={onAddNote}
            />
          }
        >
          {notes.length === 0 ? (
            <SectionEmpty icon={PenOff}>No side notes recorded.</SectionEmpty>
          ) : (
            <ul className="space-y-2">
              {notes.map((note) => {
                const origin = staffOriginBadge(note.origin);
                const badges: FeedbackBadge[] = [
                  ...(origin ? [origin] : []),
                  reviewStatusBadge(note.status),
                ];
                return (
                  <li
                    key={note.id}
                    className="rounded-md border border-border-subtle px-3 py-2"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="jts-overline text-ink-muted">
                        {noteTypeLabel(note.noteType)}
                      </p>
                      <FeedbackBadges badges={badges} />
                    </div>
                    <p className="mt-1 text-sm text-ink">{note.text}</p>
                    {note.subjectParticipantId === null ? (
                      <p className="mt-1 text-xs text-ink-subtle">
                        No resolved subject — kept for review.
                      </p>
                    ) : (
                      <p className="mt-1 text-xs text-ink-subtle">
                        About {participantLabel(note.subjectDisplayName)}
                      </p>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      isDisabled={noteUpdatePending}
                      className="mt-2"
                      onPress={() => {
                        void onNoteReviewChange(
                          note.id,
                          note.status === "dismissed" ? "new" : "dismissed",
                        );
                      }}
                    >
                      {note.status === "dismissed"
                        ? "Reopen for review"
                        : "Dismiss"}
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </DetailSection>

        {hasAnyAction ? (
          <DetailSection icon={SlidersHorizontal} title="Actions">
            <div className="flex flex-wrap gap-2">
              {capabilities.canTakeOver ? (
                <ConfirmAction
                  label="Take over"
                  icon={<Hand aria-hidden="true" className="size-4" />}
                  heading="Take over this conversation"
                  description={
                    <>
                      The bot stops replying to {name} and you become
                      responsible for the thread. Nothing is sent right now.
                    </>
                  }
                  confirmLabel="Take over"
                  isPending={pendingAction === "take-over"}
                  isDisabled={pendingAction !== null}
                  onConfirm={onTakeOver}
                />
              ) : null}

              {capabilities.canResumeBot ? (
                <ConfirmAction
                  label="Resume bot"
                  icon={
                    <BotMessageSquare aria-hidden="true" className="size-4" />
                  }
                  heading="Hand back to the bot"
                  description={
                    <>
                      The bot resumes the questionnaire with {name} from its
                      current goal. Your messages stay in the transcript as
                      context.
                    </>
                  }
                  confirmLabel="Resume bot"
                  isPending={pendingAction === "resume-bot"}
                  isDisabled={pendingAction !== null}
                  onConfirm={onResumeBot}
                />
              ) : null}

              {capabilities.canClose ? (
                <ConfirmAction
                  label="Close"
                  tone="danger"
                  icon={<SquareX aria-hidden="true" className="size-4" />}
                  heading="Close this conversation"
                  description={
                    <>
                      Closes {name}&rsquo;s conversation as cancelled and
                      cancels anything still queued for them. It cannot be
                      reopened, and no other conversation is affected.
                    </>
                  }
                  confirmLabel="Close conversation"
                  isPending={pendingAction === "close"}
                  isDisabled={pendingAction !== null}
                  onConfirm={onClose}
                />
              ) : null}
            </div>
          </DetailSection>
        ) : null}
      </div>
    </section>
  );
}
