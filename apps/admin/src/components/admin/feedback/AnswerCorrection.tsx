import { Button, ListBox, Select } from "@heroui/react";
import { Check, PencilLine, Trash2, X } from "lucide-react";
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
}

/**
 * One recorded answer, and the two ways an operator can disagree with it.
 *
 * A score the model read wrong is edited in place — press the value, pick the
 * right one, save. An answer recorded about the wrong person is withdrawn behind
 * the same confirmation dialog every other consequential action on this screen
 * uses. Neither is a workflow: there is nothing to assign, nothing to approve,
 * and the correction lands on the row the moment it is saved.
 *
 * Unlike everything that could send a message, these are not gated on the
 * conversation's capability flags. A closed thread is exactly where they matter:
 * once it closes the model will never read it again, so a wrong number stays
 * wrong for good unless a person can change it.
 */
export function AnswerValue({
  answer,
  onCorrect,
  onWithdraw,
  isDisabled,
}: AnswerValueProps) {
  const [isEditing, setEditing] = useState(false);
  const [draft, setDraft] = useState<number>(answer.valueInt ?? 3);
  const [isSaving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const corrected = correctionSummary(answer);
  const label = questionLabel(answer.questionKey);
  const subject = participantLabel(answer.subjectDisplayName);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await onCorrect(answer.id, draft);
      setEditing(false);
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

  if (isEditing) {
    return (
      /* Divs, not spans: the picker and the buttons are block-level widgets, and
         nesting them in a span is invalid markup. */
      <div className="flex flex-col items-end gap-1">
        <div className="flex items-center gap-1.5">
          <Select
            aria-label={`Correct the ${label.toLocaleLowerCase()} answer`}
            selectedKey={String(draft)}
            isDisabled={isSaving}
            onSelectionChange={(key) => setDraft(Number(key ?? draft))}
          >
            <Select.Trigger className="w-24">
              <Select.Value />
              <Select.Indicator />
            </Select.Trigger>
            <Select.Popover>
              <ListBox>
                {FEEDBACK_SCORE_CHOICES.map((choice) => (
                  <ListBox.Item
                    key={choice}
                    id={String(choice)}
                    textValue={`${choice} / 5`}
                  >
                    {choice} / 5
                  </ListBox.Item>
                ))}
              </ListBox>
            </Select.Popover>
          </Select>
          <Button
            size="sm"
            aria-label="Save correction"
            isDisabled={isSaving || draft === answer.valueInt}
            onPress={() => {
              void save();
            }}
          >
            <Check aria-hidden="true" className="size-4" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            aria-label="Cancel correction"
            isDisabled={isSaving}
            onPress={() => {
              setEditing(false);
              setDraft(answer.valueInt ?? 3);
              setError(null);
            }}
          >
            <X aria-hidden="true" className="size-4" />
          </Button>
        </div>
        {error ? (
          <p role="alert" className="text-xs font-normal text-danger">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col items-end gap-0.5">
      <div className="flex items-center gap-1.5">
        {answer.valueInt === null ? (
          <ParticipantName displayName={answer.subjectDisplayName} />
        ) : (
          `${answer.valueInt} / 5`
        )}

        {canCorrectAnswerValue(answer) ? (
          <Button
            size="sm"
            variant="ghost"
            aria-label={`Correct the ${label.toLocaleLowerCase()} answer`}
            isDisabled={isDisabled}
            onPress={() => {
              setDraft(answer.valueInt ?? 3);
              setEditing(true);
            }}
          >
            <PencilLine aria-hidden="true" className="size-4" />
          </Button>
        ) : null}

        {canWithdrawAnswer(answer) ? (
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
