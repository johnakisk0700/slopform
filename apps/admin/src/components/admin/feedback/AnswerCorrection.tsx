import { Slider } from "@heroui/react";
import { clsx } from "clsx";
import { UserPen, X } from "lucide-react";
import { useState } from "react";

import type { FeedbackConversationResultsDtoOutput } from "../../../api/generated/model/feedbackConversationResultsDtoOutput";
import {
  FEEDBACK_SCORE_CHOICES,
  canWithdrawAnswer,
  correctionSummary,
  withdrawalDescription,
} from "../../../features/feedback/answerCorrections";
import {
  directedQuestionTone,
  type DirectedQuestionKey,
} from "../../../features/feedback/directedAnswers";
import {
  participantLabel,
  questionLabel,
  type FeedbackTone,
} from "../../../features/feedback/labels";
import { apiErrorMessage } from "../../../lib/api";
import { ConfirmAction } from "./ConfirmAction";
import { ParticipantName } from "./ParticipantName";

type Answer = FeedbackConversationResultsDtoOutput["answers"][number];

const MIN_SCORE = FEEDBACK_SCORE_CHOICES[0] ?? 1;
const MAX_SCORE =
  FEEDBACK_SCORE_CHOICES[FEEDBACK_SCORE_CHOICES.length - 1] ?? 5;

interface ScoreAnswerProps {
  /** The question's own name, on the line the value sits at the end of. */
  label: string;
  answer: Answer;
  /** Rejects on failure; this row reports it where the operator is looking. */
  onCorrect: (answerId: string, valueInt: number) => Promise<void>;
  isDisabled: boolean;
  /**
   * The card-level edit mode. At rest the score is plain text with no controls
   * at all; one «Edit» press gives it a slider.
   */
  editable: boolean;
}

/**
 * The one answer that is a number, and the way an operator disagrees with it.
 *
 * The slider owns a line of its own under the question, at the panel's full
 * width, with the value at the end of the line above it. Sharing a line with the
 * label and the number, it had about a third of the card to express five steps —
 * the thumb moved a few pixels per point, which is a poor control for the one
 * value on this screen that reaches a seating plan.
 *
 * Deliberately not gated on the conversation's capability flags. A closed thread
 * is exactly where this matters: once it closes the model will never revisit it,
 * so a wrong number stays wrong for good unless a person can change it.
 */
export function ScoreAnswer({
  label,
  answer,
  onCorrect,
  isDisabled,
  editable,
}: ScoreAnswerProps) {
  const [draft, setDraft] = useState<number>(answer.valueInt ?? 3);
  const [isSaving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const corrected = correctionSummary(answer);

  // Saves on thumb release, not on every step the thumb crosses.
  async function saveValue(value: number) {
    if (value === answer.valueInt) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onCorrect(answer.id, value);
    } catch (cause) {
      setError(apiErrorMessage(cause, "The correction could not be saved."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="grid gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm text-ink">{label}</span>
        <span className="text-sm font-semibold text-ink tabular-nums">
          {editable ? draft : answer.valueInt} / {MAX_SCORE}
        </span>
      </div>

      {editable ? (
        <Slider
          aria-label={`Set the ${label.toLocaleLowerCase()} answer`}
          minValue={MIN_SCORE}
          maxValue={MAX_SCORE}
          step={1}
          value={draft}
          isDisabled={isDisabled || isSaving}
          onChange={(value) => {
            setDraft(Array.isArray(value) ? (value[0] ?? draft) : value);
          }}
          onChangeEnd={(value) => {
            const settled = Array.isArray(value) ? (value[0] ?? draft) : value;
            setDraft(settled);
            void saveValue(settled);
          }}
          className="w-full"
        >
          <Slider.Track>
            <Slider.Fill />
            <Slider.Thumb />
          </Slider.Track>
        </Slider>
      ) : null}

      {/* A corrected value is not the model's reading any more, and a number
          with no author is what made that impossible to tell. */}
      {corrected ? (
        <p className="text-xs text-ink-subtle">{corrected}</p>
      ) : null}

      {error ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * How a person's pill paints under each question. The same status tokens the
 * badges use, so the three groups separate at a glance in both themes — and
 * never by colour alone: each group keeps its heading and its glyph, and each
 * pill its name.
 */
const PILL_TONE_STYLES: Record<FeedbackTone, string> = {
  neutral: "border-border bg-surface-sunken text-ink",
  info: "border-info-border bg-info-soft text-ink",
  success: "border-success-border bg-success-soft text-ink",
  warning: "border-warning-border bg-warning-soft text-ink",
  danger: "border-danger-border bg-danger-soft text-ink",
  accent: "border-copper/40 bg-copper-soft text-ink",
};

interface AnswerPersonProps {
  answer: Answer;
  questionKey: DirectedQuestionKey;
  /** Rejects on failure; this row reports it where the operator is looking. */
  onWithdraw: (answerId: string) => Promise<void>;
  isDisabled: boolean;
  /** The card-level edit mode: at rest a pill carries no controls. */
  editable: boolean;
}

/**
 * One person recorded under one directed question.
 *
 * A pill rather than a line of text, because these answers are a set and read
 * as one: «Μαρία, Κώστας» under LIKED is a row an operator scans, where the same
 * two names stacked as right-aligned sentences were three lines of prose to
 * parse. The remove control lives inside the pill it removes, so there is no
 * question which name a × belongs to — and it still opens the same confirmation
 * every destructive action on this screen uses, because a withdrawal is a hard
 * delete that only the audit log remembers.
 */
export function AnswerPerson({
  answer,
  questionKey,
  onWithdraw,
  isDisabled,
  editable,
}: AnswerPersonProps) {
  const [error, setError] = useState<string | null>(null);

  const label = questionLabel(answer.questionKey);
  const subject = participantLabel(answer.subjectDisplayName);
  const corrected = correctionSummary(answer);
  const removable = editable && canWithdrawAnswer(answer);

  async function withdraw() {
    setError(null);
    try {
      await onWithdraw(answer.id);
    } catch (cause) {
      // The dialog has already closed by the time this lands, so the reason
      // belongs on the row rather than inside a dialog nobody is looking at.
      setError(apiErrorMessage(cause, "The answer could not be withdrawn."));
    }
  }

  return (
    <li className="min-w-0">
      <span
        className={clsx(
          "inline-flex max-w-full items-center gap-1.5 rounded-full border py-0.5 text-sm font-semibold",
          removable ? "pr-1 pl-2.5" : "px-2.5",
          PILL_TONE_STYLES[directedQuestionTone(questionKey)],
        )}
      >
        {/* An operator's own answer says so on the pill: a month later nobody
            should have to guess whether the participant named this person or
            somebody wrote it down after a phone call. */}
        {answer.origin === "staff" ? (
          <>
            <UserPen aria-hidden="true" className="size-3.5 shrink-0" />
            <span className="sr-only">Recorded by staff:</span>
          </>
        ) : null}
        <span className="truncate">
          <ParticipantName displayName={answer.subjectDisplayName} />
        </span>
        {removable ? (
          <ConfirmAction
            label={`Withdraw the ${label.toLocaleLowerCase()} answer about ${subject}`}
            tone="danger"
            isIconOnly
            triggerClassName="size-5 min-h-0 min-w-0 rounded-full p-0"
            icon={<X aria-hidden="true" className="size-3.5" />}
            heading="Withdraw this answer"
            description={withdrawalDescription(label, subject)}
            confirmLabel="Withdraw answer"
            isDisabled={isDisabled}
            onConfirm={withdraw}
          />
        ) : null}
      </span>

      {corrected ? (
        <span className="mt-0.5 block text-xs text-ink-subtle">
          {corrected}
        </span>
      ) : null}

      {error ? (
        <span role="alert" className="mt-0.5 block text-xs text-danger">
          {error}
        </span>
      ) : null}
    </li>
  );
}
