import { Avatar, Button, ListBox, Select, TextArea } from "@heroui/react";
import { clsx } from "clsx";
import type { LucideIcon } from "lucide-react";
import {
  AtSign,
  Ban,
  BotMessageSquare,
  Cake,
  Check,
  Hand,
  Handshake,
  Heart,
  ListChecks,
  MapPin,
  PencilLine,
  PenOff,
  Phone,
  ScanText,
  SquareX,
  StickyNote,
  UserRound,
  UserRoundX,
} from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { Link } from "react-router";

import { useGetParticipant } from "../../../api/generated/participants";
import type { AddFeedbackConversationNoteDtoNoteType } from "../../../api/generated/model/addFeedbackConversationNoteDtoNoteType";
import type { FeedbackConversationDetailDtoOutput } from "../../../api/generated/model/feedbackConversationDetailDtoOutput";
import type { FeedbackConversationResultsDtoOutput } from "../../../api/generated/model/feedbackConversationResultsDtoOutput";
import { canCorrectAnswerValue } from "../../../features/feedback/answerCorrections";
import { goalProgress } from "../../../features/feedback/conversationView";
import {
  isDirectedQuestion,
  type DirectedQuestionKey,
} from "../../../features/feedback/directedAnswers";
import { extractionStatusLines } from "../../../features/feedback/extractionStatus";
import {
  goalStatusBadge,
  isUnresolvedParticipant,
  noteTypeLabel,
  participantLabel,
  questionLabel,
  staffOriginBadge,
  type FeedbackBadge,
} from "../../../features/feedback/labels";
import {
  STAFF_CLOSE_NOTE_MAX_LENGTH,
  STAFF_CLOSE_REASONS,
  staffCloseReasonLabel,
  type StaffCloseInput,
  type StaffCloseReason,
} from "../../../features/feedback/staffClose";
import {
  formatAgeBand,
  formatNeighborhood,
} from "../../../features/participants/profileFields";
import { AddAnswerAction } from "./AddAnswerAction";
import { AddNoteAction } from "./AddNoteAction";
import { AnswerPerson, ScoreAnswer } from "./AnswerCorrection";
import { ConfirmAction } from "./ConfirmAction";
import { FeedbackBadges } from "./FeedbackBadges";
import { ParticipantName } from "./ParticipantName";

export type ConversationPendingAction =
  "take-over" | "resume-bot" | "close" | null;

/**
 * The detail panels of one conversation, plus the actions that steer it.
 *
 * These used to be one tall right column of six stacked sections, which meant
 * the notes an operator had just written sat below four scrolls of reference
 * data. They are separate cards now, laid out as a strip under the transcript:
 * what the conversation produced (progress and answers), what staff wrote about
 * it (notes), and who it is with (the respondent's actual profile record).
 * `ConversationActions` and `ReadingStatus` belong to the transcript instead —
 * both are about the messages: the actions render at the foot of them, the
 * reading status at the end of them, inside the scroll.
 *
 * Every control that could reach a participant is gated on the capability flags
 * the backend publishes for this conversation — a STOP-closed thread simply
 * reports no capabilities and the whole action row disappears, with no
 * client-side rule deciding that. «Add note» and the per-answer correction and
 * withdrawal are the exceptions, and deliberately so: recording what is true is
 * not steering the conversation, so they stay available after the thread closes,
 * which is exactly where they matter.
 */

/**
 * One card in the strip. It repeats the list and transcript panes' own shell —
 * hairline border, its own header, its own scroll container — so the whole
 * screen reads as one set of panels rather than a pane plus some boxes.
 */
function Panel({
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
      className="flex max-h-[44vh] min-h-0 flex-col overflow-hidden rounded-md border border-border bg-surface"
    >
      <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
        <h2
          id={headingId}
          className="flex items-center gap-2 jts-overline text-ink-muted"
        >
          <Icon aria-hidden="true" className="size-4 shrink-0" />
          {title}
        </h2>
        {action}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3.5">
        {children}
      </div>
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

interface ConversationActionsProps {
  conversation: FeedbackConversationDetailDtoOutput;
  onTakeOver: () => Promise<void>;
  onResumeBot: () => Promise<void>;
  onClose: (input: StaffCloseInput) => Promise<void>;
  pendingAction: ConversationPendingAction;
}

/**
 * Take over, hand back, close — rendered at the foot of the transcript, on the
 * line that says who may write there. That line is the question these buttons
 * answer, and it is where an operator already is when they decide to step in.
 * The transcript renders the row only while something can act, so a closed
 * thread's foot disappears instead of renting an empty strip.
 */
export function ConversationActions({
  conversation,
  onTakeOver,
  onResumeBot,
  onClose,
  pendingAction,
}: ConversationActionsProps) {
  const noteId = useId();
  const [closeReason, setCloseReason] = useState<StaffCloseReason | null>(null);
  const [closeNote, setCloseNote] = useState("");
  const capabilities = conversation.capabilities;
  const hasAnyAction =
    capabilities.canTakeOver ||
    capabilities.canResumeBot ||
    capabilities.canClose;

  if (!hasAnyAction) {
    return null;
  }

  const name = participantLabel(conversation.respondentDisplayName);

  return (
    <div className="flex flex-wrap items-center gap-2">
      {capabilities.canTakeOver ? (
        <ConfirmAction
          label="Take over"
          icon={<Hand aria-hidden="true" className="size-4" />}
          heading="Take over this conversation"
          description={
            <>
              The bot stops replying to {name} and you become responsible for
              the thread. Nothing is sent right now.
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
          icon={<BotMessageSquare aria-hidden="true" className="size-4" />}
          heading="Hand back to the bot"
          description={
            <>
              The bot resumes the questionnaire with {name} from its current
              goal. Your messages stay in the transcript as context.
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
              Closes {name}&rsquo;s conversation as cancelled and cancels
              anything still queued for them. It cannot be reopened, and no
              other conversation is affected. Say why — a month later the
              lifecycle only remembers that a human closed it.
            </>
          }
          confirmLabel="Close conversation"
          isPending={pendingAction === "close"}
          isDisabled={pendingAction !== null}
          isConfirmDisabled={closeReason === null}
          onConfirm={async () => {
            if (closeReason === null) {
              return;
            }
            const trimmed = closeNote.trim();
            await onClose({
              reason: closeReason,
              ...(trimmed === "" ? {} : { note: trimmed }),
            });
            setCloseReason(null);
            setCloseNote("");
          }}
        >
          <div className="grid gap-1.5">
            <span className="jts-overline text-ink-muted">Reason</span>
            <Select
              aria-label="Why this conversation is closing"
              placeholder="Choose a reason"
              selectedKey={closeReason}
              onSelectionChange={(key) => {
                const value = key == null ? null : String(key);
                setCloseReason(
                  value !== null &&
                    (STAFF_CLOSE_REASONS as readonly string[]).includes(value)
                    ? (value as StaffCloseReason)
                    : null,
                );
              }}
            >
              <Select.Trigger className="w-full">
                <Select.Value />
                <Select.Indicator />
              </Select.Trigger>
              <Select.Popover>
                <ListBox>
                  {STAFF_CLOSE_REASONS.map((reason) => (
                    <ListBox.Item
                      key={reason}
                      id={reason}
                      textValue={staffCloseReasonLabel(reason)}
                    >
                      {staffCloseReasonLabel(reason)}
                    </ListBox.Item>
                  ))}
                </ListBox>
              </Select.Popover>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <label htmlFor={noteId} className="jts-overline text-ink-muted">
              Note (optional)
            </label>
            <TextArea
              id={noteId}
              value={closeNote}
              onChange={(change) => setCloseNote(change.target.value)}
              maxLength={STAFF_CLOSE_NOTE_MAX_LENGTH}
              rows={2}
              disabled={pendingAction === "close"}
              placeholder="Anything a later reader should know…"
              className="w-full"
            />
          </div>
        </ConfirmAction>
      ) : null}
    </div>
  );
}

interface ProgressPanelProps {
  conversation: FeedbackConversationDetailDtoOutput;
  /** The campaign's event, whose present attendees are the D16 candidates. */
  eventId: string;
  results: FeedbackConversationResultsDtoOutput | undefined;
  resultsLoading: boolean;
  resultsError: string | null;
  /** Rejects on failure; the answer's own row reports the reason. */
  onCorrectAnswer: (answerId: string, valueInt: number) => Promise<void>;
  onWithdrawAnswer: (answerId: string) => Promise<void>;
  onAddAnswer: (
    questionKey: DirectedQuestionKey,
    subjectParticipantId: string,
  ) => Promise<void>;
  answerUpdatePending: boolean;
  addAnswerPending: boolean;
}

/**
 * One glyph per directed question, tinted with that question's own status
 * colour.
 *
 * The three groups are the part of this card an operator reads fastest and the
 * part they must not confuse — «Μαρία» under LIKED and under AVOID are opposite
 * facts about the same evening. Glyph, heading and pill tint all say which is
 * which, so no single channel is carrying it.
 */
const DIRECTED_QUESTION_GLYPHS: Record<
  DirectedQuestionKey,
  { icon: LucideIcon; className: string }
> = {
  liked: { icon: Heart, className: "text-success" },
  meet_again: { icon: Handshake, className: "text-info" },
  avoid: { icon: Ban, className: "text-danger" },
};

/**
 * What the questionnaire has got out of this conversation: one row per goal,
 * carrying either the answer or the reason there isn't one.
 *
 * The two used to be separate lists, and every answered goal therefore said
 * itself twice — «Score · Answered» above, «SCORE · 5 / 5» below. An answer is
 * the strongest possible statement that a goal is answered, so where there is
 * one it replaces the badge, and the badge is left to say the only things an
 * answer cannot: not asked, awaiting a reply, skipped.
 *
 * Each answer is also where it can be disagreed with. An operator who reads a
 * score the model got wrong could previously do nothing about it — recorded
 * answers were immutable from the product — and on a closed thread that was
 * permanent, because nothing will ever re-read it.
 */
export function ProgressPanel({
  conversation,
  eventId,
  results,
  resultsLoading,
  resultsError,
  onCorrectAnswer,
  onWithdrawAnswer,
  onAddAnswer,
  answerUpdatePending,
  addAnswerPending,
}: ProgressPanelProps) {
  const progress = goalProgress(conversation.goals);
  const answers = results?.answers ?? [];
  // Reading and changing are two different visits to this card. At rest every
  // answer is plain text with no controls; one «Edit» press opens all the
  // rows at once — sliders on scores, withdrawal on directed answers — and
  // «Done» closes them. The per-answer pencil made each row carry its own
  // tiny toolbar all day for an action that happens once a campaign.
  const [isEditing, setEditing] = useState(false);

  return (
    /* The count is in the heading, not a sentence above the list: «2 answered,
       0 skipped, 2 outstanding of 4» restated, in prose, exactly what the four
       labelled rows under it already said. */
    <Panel
      icon={ListChecks}
      title="Progress & answers"
      action={
        <span className="flex items-center gap-2">
          <span className="text-xs font-semibold text-ink-muted tabular-nums">
            {progress.settled}/{progress.total} done
          </span>
          {/* Always available now, where it used to appear only once something
              had been recorded: edit mode is also how an answer gets added, and
              a conversation whose questions all went unanswered is exactly the
              one an operator has something to add to. */}
          <Button
            size="sm"
            variant={isEditing ? "primary" : "ghost"}
            aria-pressed={isEditing}
            onPress={() => setEditing((current) => !current)}
          >
            {isEditing ? (
              <Check aria-hidden="true" className="size-4" />
            ) : (
              <PencilLine aria-hidden="true" className="size-4" />
            )}
            {isEditing ? "Done" : "Edit"}
          </Button>
        </span>
      }
    >
      {resultsError ? (
        <p role="alert" className="mb-3 text-sm text-danger">
          {resultsError}
        </p>
      ) : null}

      <ul className="space-y-3.5">
        {conversation.goals.map((goal) => {
          const key = goal.key;
          // A question can be answered with several people (D16 subjects), so
          // a goal's row is a list of its answers, not a single value.
          const given = answers.filter((answer) => answer.questionKey === key);

          /* The score: its own line for the question and the number, and — in
             edit mode — the whole width of the card for the slider under it. */
          if (!isDirectedQuestion(key)) {
            const score = given[0];
            return (
              <li key={key}>
                {score ? (
                  /* Keyed on the recorded value too, so a slider draft never
                     survives a poll that changed the answer under it. */
                  <ScoreAnswer
                    key={`${score.id}:${score.valueInt ?? ""}`}
                    label={questionLabel(key)}
                    answer={score}
                    onCorrect={onCorrectAnswer}
                    isDisabled={answerUpdatePending}
                    editable={isEditing && canCorrectAnswerValue(score)}
                  />
                ) : (
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm text-ink">
                      {questionLabel(key)}
                    </span>
                    <FeedbackBadges badges={[goalStatusBadge(goal.status)]} />
                  </div>
                )}
              </li>
            );
          }

          /* A question answered with people: its own heading with the people
             on the line under it, so the three groups read as three sets
             rather than as one column of right-aligned names. */
          const glyph = DIRECTED_QUESTION_GLYPHS[key];
          return (
            <li key={key}>
              <div className="flex min-h-7 items-center justify-between gap-2">
                <h3 className="flex items-center gap-1.5 jts-overline text-ink-muted">
                  <glyph.icon
                    aria-hidden="true"
                    className={clsx("size-3.5 shrink-0", glyph.className)}
                  />
                  {questionLabel(key)}
                </h3>
                <span className="flex items-center gap-2">
                  {given.length === 0 ? (
                    <FeedbackBadges badges={[goalStatusBadge(goal.status)]} />
                  ) : null}
                  {isEditing ? (
                    <AddAnswerAction
                      eventId={eventId}
                      respondentParticipantId={
                        conversation.respondentParticipantId
                      }
                      questionKey={key}
                      answers={answers}
                      isDisabled={eventId === "" || answerUpdatePending}
                      isPending={addAnswerPending}
                      onAdd={(subjectParticipantId) =>
                        onAddAnswer(key, subjectParticipantId)
                      }
                    />
                  ) : null}
                </span>
              </div>
              {given.length > 0 ? (
                <ul className="mt-1 flex flex-wrap items-start gap-1.5">
                  {given.map((answer) => (
                    <AnswerPerson
                      key={answer.id}
                      answer={answer}
                      questionKey={key}
                      onWithdraw={onWithdrawAnswer}
                      isDisabled={answerUpdatePending}
                      editable={isEditing}
                    />
                  ))}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ul>

      {/* Extraction lands after the message, so «answered» with no answer yet
          is a real, temporary state — and it is the one the reading status at
          the foot of the transcript explains. */}
      {resultsLoading && results === undefined ? (
        <p role="status" className="mt-3 text-sm text-ink-muted">
          Loading answers…
        </p>
      ) : null}
    </Panel>
  );
}

interface NotesPanelProps {
  conversation: FeedbackConversationDetailDtoOutput;
  /** The campaign's event, for the note subject picker's D16 candidates. */
  eventId: string;
  results: FeedbackConversationResultsDtoOutput | undefined;
  onNoteReviewChange: (
    noteId: string,
    status: "new" | "dismissed",
  ) => Promise<void>;
  onAddNote: (input: {
    noteType: AddFeedbackConversationNoteDtoNoteType;
    text: string;
    subjectParticipantId?: string;
  }) => Promise<void>;
  noteUpdatePending: boolean;
  addNotePending: boolean;
}

/**
 * Side notes: what extraction picked up beyond the questionnaire, and what
 * staff wrote down themselves. Its own card because it is the one part of the
 * detail an operator writes to, and it was the part buried deepest.
 */
export function NotesPanel({
  conversation,
  eventId,
  results,
  onNoteReviewChange,
  onAddNote,
  noteUpdatePending,
  addNotePending,
}: NotesPanelProps) {
  const notes = results?.notes ?? [];

  return (
    <Panel
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
            const badges: FeedbackBadge[] = origin ? [origin] : [];
            // The card itself wears the review state: a note waiting for a
            // person is a warning-tinted card, a handled one is plain. The
            // «Needs review» pill this replaces sat in the corner of every
            // unhandled note saying what the tint now says at a glance.
            const needsReview = note.status !== "dismissed";
            return (
              <li
                key={note.id}
                className={clsx(
                  "rounded-md border px-3 py-2",
                  needsReview
                    ? "border-warning-border bg-warning-soft"
                    : "border-border-subtle",
                )}
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
                {/* Secondary on the tinted card, not ghost: a ghost button on
                    the warning wash is the same colour as the card and reads
                    as disabled. On the plain, already-handled card the quiet
                    ghost is right. */}
                <Button
                  size="sm"
                  variant={needsReview ? "secondary" : "ghost"}
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
    </Panel>
  );
}

interface RespondentPanelProps {
  conversation: FeedbackConversationDetailDtoOutput;
}

/**
 * One profile field: a muted glyph, its label, its value. A field with nothing
 * stored shows the same quiet em dash the profile route uses, so an empty
 * value never reads as a failed load.
 */
function Field({
  icon: Icon,
  label,
  value,
}: {
  icon: LucideIcon;
  label: string;
  value: string | null;
}) {
  return (
    <div className="flex gap-2.5">
      <Icon
        aria-hidden="true"
        className="mt-0.5 size-4 shrink-0 text-ink-muted"
      />
      <div className="min-w-0">
        <dt className="jts-overline text-ink-muted">{label}</dt>
        <dd className="text-sm break-words text-ink">
          {value ?? <span className="text-ink-subtle">—</span>}
        </dd>
      </div>
    </div>
  );
}

/**
 * Who this conversation is actually with: the stored participant record, not
 * just the name and number the campaign launched against.
 *
 * The record is read through the same `getParticipant` endpoint the profile
 * route uses, and rendered with the same field formatting, so an operator
 * deciding whether a disclosure needs a call does not have to open a second
 * tab to learn who they would be calling. An unresolved id (D18) has no record
 * to fetch, so the query never runs for one.
 */
export function RespondentPanel({ conversation }: RespondentPanelProps) {
  const name = participantLabel(conversation.respondentDisplayName);
  const unresolved = isUnresolvedParticipant(
    conversation.respondentDisplayName,
  );
  const monogram = unresolved ? "?" : name.charAt(0).toLocaleUpperCase();

  const participantQuery = useGetParticipant(
    conversation.respondentParticipantId,
    { query: { enabled: !unresolved } },
  );
  const participant = participantQuery.data;

  return (
    <Panel icon={UserRound} title="Respondent">
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
            <p className="truncate text-sm font-bold text-ink">
              <ParticipantName
                displayName={conversation.respondentDisplayName}
              />
            </p>
          ) : (
            <Link
              to={`/admin/participants/${conversation.respondentParticipantId}`}
              className="block truncate text-sm font-bold text-primary underline-offset-2 hover:underline"
            >
              {name}
            </Link>
          )}
          <p className="truncate text-xs text-ink-muted tabular-nums">
            {conversation.phoneAtLaunch}
          </p>
        </div>
      </div>

      <div className="mt-4 border-t border-border-subtle pt-3.5">
        {unresolved ? (
          <SectionEmpty icon={UserRoundX}>
            This id no longer matches a participant, so there is no profile to
            read.
          </SectionEmpty>
        ) : participantQuery.isError ? (
          <p role="alert" className="text-sm text-danger">
            This participant&rsquo;s profile could not be loaded.
          </p>
        ) : participant === undefined ? (
          <p role="status" className="text-sm text-ink-muted">
            Loading profile…
          </p>
        ) : (
          <>
            <dl className="grid gap-3.5">
              <Field
                icon={AtSign}
                label="Email"
                value={participant.emailNormalized}
              />
              <Field
                icon={Phone}
                label="Phone on file"
                value={participant.phoneE164}
              />
              <Field
                icon={MapPin}
                label="Neighborhood"
                value={formatNeighborhood(participant.preferredNeighborhood)}
              />
              <Field
                icon={Cake}
                label="Age band"
                value={formatAgeBand(participant.ageBand)}
              />
            </dl>
            {/* Exceptions only: everyone in a feedback campaign is ordinarily
                opted in, so only the absence of consent is news — a green
                badge on the normal case was one more thing to read on every
                thread. */}
            {!participant.postEventFeedbackWhatsappOptIn ||
            (participant.phoneE164 !== null &&
              participant.phoneE164 !== conversation.phoneAtLaunch) ? (
              <div className="mt-3.5 flex flex-wrap items-center gap-2">
                {!participant.postEventFeedbackWhatsappOptIn ? (
                  <FeedbackBadges
                    badges={[
                      {
                        key: "opt-in",
                        label: "Not opted in",
                        tone: "warning",
                      },
                    ]}
                  />
                ) : null}
                {/* The number the campaign launched against is frozen on the
                    conversation; a profile edited since would otherwise make
                    the transcript's number look wrong. */}
                {participant.phoneE164 !== null &&
                participant.phoneE164 !== conversation.phoneAtLaunch ? (
                  <p className="text-xs text-ink-subtle">
                    The profile number has changed since launch.
                  </p>
                ) : null}
              </div>
            ) : null}
          </>
        )}
      </div>
    </Panel>
  );
}

interface ReadingStatusProps {
  conversation: FeedbackConversationDetailDtoOutput;
}

/**
 * How far behind the reading of this conversation is (ΑΝΑΓΝΩΣΗ).
 *
 * A feedback conversation is read by a delayed background job, not on arrival,
 * and this line is the only place that says so. It renders at the end of the
 * messages, inside the transcript's scroll, the way a read receipt ends a
 * thread: it is about these messages, and it answers «why has that answer not
 * appeared yet» directly under the message the answer would come from. It
 * stays quiet while the reading is current and takes a tinted block only when
 * it is behind or has failed.
 */
export function ReadingStatus({ conversation }: ReadingStatusProps) {
  const extractionLines = extractionStatusLines(conversation.extraction);
  const attention = extractionLines.attention;

  return (
    /*
      Polite live region: unread count and due time change under the reader as
      the quiet window runs and the worker catches up. Same text across a 3s
      poll does not re-announce. Not a spinner — a dead worker must not look
      like progress.

      One line, and a tinted one only when the reading is behind or has failed.
      Current reading is the normal case and the transcript is what the pane is
      for, so the normal case costs it a single row of muted text.
    */
    <p
      role="status"
      aria-live="polite"
      className={clsx(
        "flex min-w-0 flex-wrap items-center gap-x-2 text-xs",
        attention === "danger"
          ? "rounded-sm border border-danger-border bg-danger-soft px-2 py-1 text-danger"
          : attention === "pending"
            ? "rounded-sm border border-warning-border bg-warning-soft px-2 py-1 text-warning"
            : "text-ink-muted",
      )}
    >
      <span className="flex items-center gap-1.5 font-semibold">
        <ScanText aria-hidden="true" className="size-3.5 shrink-0" />
        {extractionLines.unread}
      </span>
      {extractionLines.schedule ? (
        <span className={attention === "none" ? "text-ink-subtle" : undefined}>
          {extractionLines.schedule}
        </span>
      ) : null}
      {/* Which model read it matters when the reading went wrong; while it is
          current it is noise on the one line this status gets. */}
      {attention !== "none" && extractionLines.model ? (
        <span className="tabular-nums">{extractionLines.model}</span>
      ) : null}
    </p>
  );
}
