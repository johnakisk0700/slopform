import { Button, ListBox, Modal, Select, TextArea } from "@heroui/react";
import { NotebookPen } from "lucide-react";
import { useId, useState } from "react";

import { useListEventFeedbackCandidates } from "../../../api/generated/events";
import type { AddFeedbackConversationNoteDtoNoteType } from "../../../api/generated/model/addFeedbackConversationNoteDtoNoteType";
import { noteTypeLabel } from "../../../features/feedback/labels";

/** Mirrors the backend's `feedback_notes_text_length_check`. */
export const FEEDBACK_NOTE_TEXT_MAX_LENGTH = 500;

const NOTE_TYPES: readonly AddFeedbackConversationNoteDtoNoteType[] = [
  "general",
  "activity_interest",
];

const NO_SUBJECT = "__none__";

export interface AddNoteActionProps {
  /** The campaign's event, whose present attendees are the D16 candidates. */
  eventId: string;
  respondentParticipantId: string;
  isDisabled: boolean;
  isPending: boolean;
  /** Rejects on failure; the dialog keeps its context and shows the reason. */
  onAdd: (input: {
    noteType: AddFeedbackConversationNoteDtoNoteType;
    text: string;
    subjectParticipantId?: string;
  }) => Promise<void>;
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message !== ""
    ? cause.message
    : fallback;
}

/**
 * «Add note»: what an operator learned outside the thread, written into the
 * same notes list the extraction fills.
 *
 * Two things keep it honest. The subject picker offers only the campaign
 * event's current D16 candidates, fetched from the same endpoint extraction
 * uses, so a note cannot be aimed at someone the respondent never sat with —
 * and the backend re-checks it anyway. And the note is stored with staff
 * provenance, so it is labelled as staff-written everywhere it appears rather
 * than blending into participant testimony.
 */
export function AddNoteAction({
  eventId,
  respondentParticipantId,
  isDisabled,
  isPending,
  onAdd,
}: AddNoteActionProps) {
  const textId = useId();
  const [isOpen, setOpen] = useState(false);
  const [noteType, setNoteType] =
    useState<AddFeedbackConversationNoteDtoNoteType>("general");
  const [subjectId, setSubjectId] = useState<string>(NO_SUBJECT);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);

  const candidatesQuery = useListEventFeedbackCandidates(
    eventId,
    { respondentParticipantId },
    { query: { enabled: isOpen && eventId !== "" } },
  );
  const candidates = candidatesQuery.data?.items ?? [];

  function reset() {
    setNoteType("general");
    setSubjectId(NO_SUBJECT);
    setText("");
    setError(null);
  }

  async function handleSave() {
    const trimmed = text.trim();
    if (trimmed === "") {
      return;
    }
    setError(null);
    try {
      await onAdd({
        noteType,
        text: trimmed,
        ...(subjectId === NO_SUBJECT
          ? {}
          : { subjectParticipantId: subjectId }),
      });
      reset();
      setOpen(false);
    } catch (cause) {
      setError(errorMessage(cause, "The note could not be saved."));
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
      <Button size="sm" variant="secondary" isDisabled={isDisabled}>
        <NotebookPen aria-hidden="true" className="size-4" />
        Add note
      </Button>
      <Modal.Backdrop>
        <Modal.Container size="sm" placement="center">
          <Modal.Dialog>
            <Modal.Header className="flex items-start justify-between gap-4">
              <Modal.Heading className="text-[1.05rem] font-bold tracking-tight text-ink">
                Add a note
              </Modal.Heading>
              <Modal.CloseTrigger />
            </Modal.Header>
            <Modal.Body className="grid gap-4">
              <p className="text-sm text-ink-muted">
                Records something you learned about this conversation. It is
                saved as a staff note and labelled as one — it is never shown as
                the participant&rsquo;s own words.
              </p>

              <div className="grid gap-1.5">
                <span className="text-[0.65rem] font-extrabold uppercase tracking-caps text-ink-muted">
                  Type
                </span>
                <Select
                  aria-label="Note type"
                  selectedKey={noteType}
                  onSelectionChange={(key) => {
                    setNoteType(
                      String(
                        key ?? "general",
                      ) as AddFeedbackConversationNoteDtoNoteType,
                    );
                  }}
                >
                  <Select.Trigger className="w-full">
                    <Select.Value />
                    <Select.Indicator />
                  </Select.Trigger>
                  <Select.Popover>
                    <ListBox>
                      {NOTE_TYPES.map((type) => (
                        <ListBox.Item
                          key={type}
                          id={type}
                          textValue={noteTypeLabel(type)}
                        >
                          {noteTypeLabel(type)}
                        </ListBox.Item>
                      ))}
                    </ListBox>
                  </Select.Popover>
                </Select>
              </div>

              <div className="grid gap-1.5">
                <span className="text-[0.65rem] font-extrabold uppercase tracking-caps text-ink-muted">
                  About (optional)
                </span>
                {candidatesQuery.isError ? (
                  <p role="alert" className="text-sm text-danger">
                    Could not load the people this note could be about. Save it
                    without a subject, or try again.
                  </p>
                ) : (
                  <Select
                    aria-label="Who the note is about"
                    isDisabled={candidatesQuery.isPending}
                    selectedKey={subjectId}
                    onSelectionChange={(key) => {
                      setSubjectId(String(key ?? NO_SUBJECT));
                    }}
                  >
                    <Select.Trigger className="w-full">
                      <Select.Value />
                      <Select.Indicator />
                    </Select.Trigger>
                    <Select.Popover>
                      <ListBox>
                        <ListBox.Item id={NO_SUBJECT} textValue="No one">
                          No one in particular
                        </ListBox.Item>
                        {candidates.map((candidate) => (
                          <ListBox.Item
                            key={candidate.participantId}
                            id={candidate.participantId}
                            textValue={candidate.displayName}
                          >
                            {candidate.displayName}
                          </ListBox.Item>
                        ))}
                      </ListBox>
                    </Select.Popover>
                  </Select>
                )}
                <p className="text-xs text-ink-muted">
                  Only people marked present at this event, apart from the
                  respondent, can be the subject of a note.
                </p>
              </div>

              <div className="grid gap-1.5">
                <label
                  htmlFor={textId}
                  className="text-[0.65rem] font-extrabold uppercase tracking-caps text-ink-muted"
                >
                  Note
                </label>
                <TextArea
                  id={textId}
                  value={text}
                  onChange={(change) => setText(change.target.value)}
                  maxLength={FEEDBACK_NOTE_TEXT_MAX_LENGTH}
                  rows={4}
                  disabled={isPending}
                  placeholder="What happened, in your own words…"
                  className="w-full"
                />
                <p className="text-xs tabular-nums text-ink-subtle">
                  {text.trim().length}/{FEEDBACK_NOTE_TEXT_MAX_LENGTH}
                </p>
              </div>

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
                isDisabled={isPending || text.trim() === ""}
                onPress={() => {
                  void handleSave();
                }}
              >
                {isPending ? "Saving…" : "Save note"}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
