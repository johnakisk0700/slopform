import { Button } from "@heroui/react";
import { clsx } from "clsx";
import { BotMessageSquare, Hand, SquareX, UserRound } from "lucide-react";
import { useId } from "react";
import { Link } from "react-router";

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
} from "../../../features/feedback/labels";
import { ConfirmAction } from "./ConfirmAction";
import { FeedbackBadges } from "./FeedbackBadges";

export interface ConversationDetailsProps {
  conversation: FeedbackConversationDetailDtoOutput;
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
  pendingAction: "take-over" | "resume-bot" | "close" | null;
  noteUpdatePending: boolean;
}

function SectionHeading({ children }: { children: string }) {
  return (
    <h3 className="mb-2 text-[0.65rem] font-extrabold uppercase tracking-caps text-ink-muted">
      {children}
    </h3>
  );
}

/**
 * The right pane: what the conversation has produced and what an operator may
 * do about it.
 *
 * Every control is gated on the capability flags the backend publishes for
 * this conversation — a STOP-closed thread simply reports no capabilities and
 * the whole action row disappears, with no client-side rule deciding that.
 */
export function ConversationDetails({
  conversation,
  results,
  resultsLoading,
  resultsError,
  onTakeOver,
  onResumeBot,
  onClose,
  onNoteReviewChange,
  pendingAction,
  noteUpdatePending,
}: ConversationDetailsProps) {
  const headingId = useId();
  const progress = goalProgress(conversation.goals);
  const capabilities = conversation.capabilities;
  const hasAnyAction =
    capabilities.canTakeOver ||
    capabilities.canResumeBot ||
    capabilities.canClose;

  const name = participantLabel(conversation.respondentDisplayName);
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
          className="text-[0.7rem] font-extrabold uppercase tracking-caps text-ink-muted"
        >
          Details
        </h2>
      </header>

      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-4 py-4">
        <div>
          <SectionHeading>Respondent</SectionHeading>
          <p
            className={clsx(
              "text-sm font-bold text-ink",
              isUnresolvedParticipant(conversation.respondentDisplayName) &&
                "italic",
            )}
          >
            {name}
          </p>
          <Link
            to="/admin/participants"
            className="mt-1 inline-flex items-center gap-1.5 text-sm font-semibold text-primary"
          >
            <UserRound aria-hidden="true" className="size-3.5" />
            Open participants
          </Link>
        </div>

        <div>
          <SectionHeading>Goal progress</SectionHeading>
          <p className="mb-2 text-sm text-ink-muted">
            {progress.answered} answered, {progress.skipped} skipped,{" "}
            {progress.outstanding} outstanding of {progress.total}.
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
        </div>

        <div>
          <SectionHeading>Answers</SectionHeading>
          {resultsError ? (
            <p role="alert" className="text-sm text-danger">
              {resultsError}
            </p>
          ) : resultsLoading && results === undefined ? (
            <p role="status" className="text-sm text-ink-muted">
              Loading answers…
            </p>
          ) : answers.length === 0 ? (
            <p className="text-sm text-ink-muted">
              Nothing extracted from this conversation yet.
            </p>
          ) : (
            <ul className="space-y-2">
              {answers.map((answer) => (
                <li
                  key={answer.id}
                  className="rounded-md border border-border-subtle px-3 py-2"
                >
                  <p className="text-[0.65rem] font-extrabold uppercase tracking-caps text-ink-muted">
                    {questionLabel(answer.questionKey)}
                  </p>
                  <p className="mt-0.5 text-sm text-ink">
                    {answer.valueInt === null
                      ? participantLabel(answer.subjectDisplayName)
                      : `${answer.valueInt} / 5`}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <SectionHeading>Notes</SectionHeading>
          {notes.length === 0 ? (
            <p className="text-sm text-ink-muted">No side notes recorded.</p>
          ) : (
            <ul className="space-y-2">
              {notes.map((note) => (
                <li
                  key={note.id}
                  className="rounded-md border border-border-subtle px-3 py-2"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-[0.65rem] font-extrabold uppercase tracking-caps text-ink-muted">
                      {noteTypeLabel(note.noteType)}
                    </p>
                    <FeedbackBadges badges={[reviewStatusBadge(note.status)]} />
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
              ))}
            </ul>
          )}
        </div>
      </div>

      {hasAnyAction ? (
        <div className="flex flex-wrap gap-2 border-t border-border px-4 py-3">
          {capabilities.canTakeOver ? (
            <ConfirmAction
              label="Take over"
              icon={<Hand aria-hidden="true" className="size-4" />}
              heading="Take over this conversation"
              description={
                <>
                  The bot stops replying to {name} and you become responsible
                  for the thread. Nothing is sent right now.
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
                  other conversation is affected.
                </>
              }
              confirmLabel="Close conversation"
              isPending={pendingAction === "close"}
              isDisabled={pendingAction !== null}
              onConfirm={onClose}
            />
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
