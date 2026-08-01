import { Button, ListBox, Modal, Select } from "@heroui/react";
import { Plus } from "lucide-react";
import { useState } from "react";

import { useListEventFeedbackCandidates } from "../../../api/generated/events";
import {
  answerCandidateChoices,
  recordAnswerDescription,
  type DirectedQuestionKey,
} from "../../../features/feedback/directedAnswers";
import {
  participantLabel,
  questionLabel,
} from "../../../features/feedback/labels";
import { apiErrorMessage } from "../../../lib/api";

interface AddAnswerActionProps {
  /** The campaign's event, whose present attendees are the D16 candidates. */
  eventId: string;
  respondentParticipantId: string;
  questionKey: DirectedQuestionKey;
  /** Every directed answer on this conversation, for the move warning. */
  answers: readonly {
    questionKey: string;
    subjectParticipantId: string | null;
  }[];
  isDisabled: boolean;
  isPending: boolean;
  /** Rejects on failure; the dialog keeps its context and shows the reason. */
  onAdd: (subjectParticipantId: string) => Promise<void>;
}

/**
 * «+»: the person an operator knows belongs under this question, recorded by
 * hand.
 *
 * It closes the half of the answer panel that was missing. A wrong `avoid`
 * could be withdrawn but the right one could never be written, so an operator
 * who learned on the phone that it is Νίκος the respondent wants to steer clear
 * of had nowhere to put it, and the seating never heard. The list it offers is
 * the event's own D16 candidates — the same endpoint extraction resolves names
 * with — so a recorded answer cannot be aimed at somebody the respondent never
 * sat with, and the backend re-checks it.
 *
 * The dialog is the same confirmation every consequential action on this screen
 * uses, for a reason particular to this one: recording `avoid` about somebody
 * currently under `liked` moves them, and an operator must read that before it
 * happens rather than notice a row missing afterwards.
 */
export function AddAnswerAction({
  eventId,
  respondentParticipantId,
  questionKey,
  answers,
  isDisabled,
  isPending,
  onAdd,
}: AddAnswerActionProps) {
  const [isOpen, setOpen] = useState(false);
  const [subjectId, setSubjectId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const candidatesQuery = useListEventFeedbackCandidates(
    eventId,
    { respondentParticipantId },
    { query: { enabled: isOpen && eventId !== "" } },
  );
  const choices = answerCandidateChoices(
    candidatesQuery.data?.items ?? [],
    answers,
    questionKey,
  );
  const chosen = choices.find((choice) => choice.participantId === subjectId);
  const label = questionLabel(questionKey);

  function reset() {
    setSubjectId(null);
    setError(null);
  }

  async function handleSave() {
    if (subjectId === null) {
      return;
    }
    setError(null);
    try {
      await onAdd(subjectId);
      reset();
      setOpen(false);
    } catch (cause) {
      setError(apiErrorMessage(cause, "The answer could not be recorded."));
    }
  }

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (isPending) {
          return;
        }
        setOpen(open);
        if (!open) {
          reset();
        }
      }}
    >
      <Button
        size="sm"
        variant="ghost"
        isIconOnly
        aria-label={`Record an answer under ${label}`}
        isDisabled={isDisabled}
      >
        <Plus aria-hidden="true" className="size-4" />
      </Button>
      <Modal.Backdrop>
        <Modal.Container size="sm" placement="center">
          <Modal.Dialog>
            <Modal.Header className="flex items-start justify-between gap-4">
              <Modal.Heading className="text-[1.05rem] font-bold tracking-tight text-ink">
                Record an answer under «{label}»
              </Modal.Heading>
              <Modal.CloseTrigger />
            </Modal.Header>
            <Modal.Body className="grid gap-4">
              <div className="grid gap-1.5">
                <span className="jts-overline text-ink-muted">Who</span>
                {candidatesQuery.isError ? (
                  <p role="alert" className="text-sm text-danger">
                    Could not load the people this answer could be about. Try
                    again.
                  </p>
                ) : (
                  <Select
                    aria-label="Who the answer is about"
                    placeholder={
                      candidatesQuery.isPending
                        ? "Loading…"
                        : choices.length === 0
                          ? "Everyone present is already recorded"
                          : "Choose a person"
                    }
                    isDisabled={
                      candidatesQuery.isPending || choices.length === 0
                    }
                    selectedKey={subjectId}
                    onSelectionChange={(key) => {
                      setSubjectId(key == null ? null : String(key));
                    }}
                  >
                    <Select.Trigger className="w-full">
                      <Select.Value />
                      <Select.Indicator />
                    </Select.Trigger>
                    <Select.Popover>
                      <ListBox>
                        {choices.map((choice) => (
                          <ListBox.Item
                            key={choice.participantId}
                            id={choice.participantId}
                            textValue={participantLabel(choice.displayName)}
                          >
                            {participantLabel(choice.displayName)}
                            {/* The cost of choosing this one, on the option
                                itself: an operator scanning the list should not
                                have to select a name to learn it moves. */}
                            {choice.movesFrom.length > 0 ? (
                              <span className="text-ink-subtle">
                                {" · now under "}
                                {choice.movesFrom
                                  .map((key) => questionLabel(key))
                                  .join(" and ")}
                              </span>
                            ) : null}
                          </ListBox.Item>
                        ))}
                      </ListBox>
                    </Select.Popover>
                  </Select>
                )}
              </div>

              <p className="text-sm text-ink-muted">
                {chosen
                  ? recordAnswerDescription({
                      questionLabel: label,
                      subjectLabel: participantLabel(chosen.displayName),
                      movesFromLabels: chosen.movesFrom.map((key) =>
                        questionLabel(key),
                      ),
                    })
                  : "Only people marked present at this event, apart from the respondent, can be the subject of an answer."}
              </p>

              {error ? (
                <p role="alert" className="text-sm text-danger">
                  {error}
                </p>
              ) : null}
            </Modal.Body>
            <Modal.Footer className="flex justify-end gap-3">
              <Button
                variant="ghost"
                isDisabled={isPending}
                onPress={() => setOpen(false)}
              >
                Cancel
              </Button>
              <Button
                isDisabled={isPending || subjectId === null}
                onPress={() => {
                  void handleSave();
                }}
              >
                {isPending ? "Recording…" : "Record answer"}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
