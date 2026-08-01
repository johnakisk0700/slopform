import { Slider } from "@heroui/react";
import { Trash2 } from "lucide-react";
import { useState } from "react";

import type { FeedbackConversationResultsDtoOutput } from "../../../api/generated/model/feedbackConversationResultsDtoOutput";
import {
  FEEDBACK_SCORE_CHOICES,
  canCorrectAnswerValue,
  canWithdrawAnswer,
  correctionSummary,
  withdrawalDescription,
} from "../../../features/feedback/answerCorrections";
import {
  participantLabel,
  questionLabel,
} from "../../../features/feedback/labels";
import { apiErrorMessage } from "../../../lib/api";
import { ConfirmAction } from "./ConfirmAction";
import { ParticipantName } from "./ParticipantName";

type Answer = FeedbackConversationResultsDtoOutput["answers"][number];

interface AnswerValueProps {
  answer: Answer;
  /** Rejects on failure; this row reports it where the operator is looking. */
  onCorrect: (answerId: string, valueInt: number) => Promise<void>;
  onWithdraw: (answerId: string) => Promise<void>;
  isDisabled: boolean;
  /**
   * The card-level edit mode. Reading and changing are two different visits
   * to this card, so at rest an answer is plain text with no controls at all,
   * and one «Edit» press opens every row at once: a score becomes a 5-step
   * slider that saves when the thumb is released, a directed answer grows its
   * withdrawal. Nothing here can *add* an answer — the backend has no
   * operator-authored answer path — so edit mode is exactly correct-and-remove.
   */
  editable: boolean;
}

/**
 * One recorded answer, and the two ways an operator can disagree with it.
 *
 * A withdrawal keeps the same confirmation dialog every other consequential
 * action on this screen uses. Neither correction is a workflow: there is
 * nothing to assign, nothing to approve, and the change lands on the row the
 * moment it is saved.
 *
 * Unlike everything that could send a message, these are not gated on the
 * conversation's capability flags. A closed thread is exactly where they
 * matter: once it closes the model will never read it again, so a wrong
 * number stays wrong for good unless a person can change it.
 */
export function AnswerValue({
  answer,
  onCorrect,
  onWithdraw,
  isDisabled,
  editable,
}: AnswerValueProps) {
  const [draft, setDraft] = useState<number>(answer.valueInt ?? 3);
  const [isSaving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const corrected = correctionSummary(answer);
  const label = questionLabel(answer.questionKey);
  const subject = participantLabel(answer.subjectDisplayName);
  const minScore = FEEDBACK_SCORE_CHOICES[0] ?? 1;
  const maxScore =
    FEEDBACK_SCORE_CHOICES[FEEDBACK_SCORE_CHOICES.length - 1] ?? 5;

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
    <div className="flex flex-col items-end gap-0.5">
      <div className="flex items-center gap-2">
        {editable && canCorrectAnswerValue(answer) ? (
          <>
            <span className="text-sm font-semibold text-ink tabular-nums">
              {draft} / {maxScore}
            </span>
            <Slider
              aria-label={`Set the ${label.toLocaleLowerCase()} answer`}
              minValue={minScore}
              maxValue={maxScore}
              step={1}
              value={draft}
              isDisabled={isDisabled || isSaving}
              onChange={(value) => {
                setDraft(Array.isArray(value) ? (value[0] ?? draft) : value);
              }}
              onChangeEnd={(value) => {
                const settled = Array.isArray(value)
                  ? (value[0] ?? draft)
                  : value;
                setDraft(settled);
                void saveValue(settled);
              }}
              className="w-36"
            >
              <Slider.Track>
                <Slider.Fill />
                <Slider.Thumb />
              </Slider.Track>
            </Slider>
          </>
        ) : answer.valueInt === null ? (
          <ParticipantName displayName={answer.subjectDisplayName} />
        ) : (
          `${answer.valueInt} / ${maxScore}`
        )}

        {editable && canWithdrawAnswer(answer) ? (
          <ConfirmAction
            label="Withdraw"
            tone="danger"
            icon={<Trash2 aria-hidden="true" className="size-4" />}
            heading="Withdraw this answer"
            description={withdrawalDescription(label, subject)}
            confirmLabel="Withdraw answer"
            isDisabled={isDisabled}
            onConfirm={withdraw}
          />
        ) : null}
      </div>

      {/* A corrected value is not the model's reading any more, and a number
          with no author is what made that impossible to tell. */}
      {corrected ? (
        <p className="text-xs font-normal text-ink-subtle">{corrected}</p>
      ) : null}

      {error ? (
        <p role="alert" className="text-xs font-normal text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
