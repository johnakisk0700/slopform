import { Button, ListBox, Modal, SearchField } from "@heroui/react";
import { Check, Phone, Search, UserRoundPlus, X } from "lucide-react";
import { useMemo, useState } from "react";

import type { ParticipantDtoOutput } from "../../../api/generated/model/participantDtoOutput";
import {
  compareParticipantsByName,
  matchesParticipantQuery,
} from "../../../features/participants/search";
import { apiErrorMessage } from "../../../lib/api";
import { ParticipantIdentity } from "../participants/ParticipantIdentity";

interface AddAttendeeActionProps {
  /** Everyone on file who is not already on this event. */
  availableParticipants: readonly ParticipantDtoOutput[];
  isDisabled: boolean;
  isPending: boolean;
  /** Rejects on failure; the dialog stays open and shows the reason. */
  onAdd: (participantId: string) => Promise<void>;
}

/**
 * «Add participant»: who else was at this dinner.
 *
 * It replaces a native `<select>` that listed every participant ever, in one
 * flat column of bare names — which meant that finding someone required
 * knowing their position in it, and that two people called Maria were
 * indistinguishable. Here the list is searchable and each row carries the
 * email and phone that actually tell them apart, and it is a dialog rather
 * than a form standing permanently above the attendance it edits.
 */
export function AddAttendeeAction({
  availableParticipants,
  isDisabled,
  isPending,
  onAdd,
}: AddAttendeeActionProps) {
  const [isOpen, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const results = useMemo(
    () =>
      availableParticipants
        .filter((row) => matchesParticipantQuery(row, query))
        .sort(compareParticipantsByName),
    [availableParticipants, query],
  );

  function reset() {
    setQuery("");
    setSelectedId(null);
    setError(null);
  }

  async function handleAdd() {
    if (selectedId === null) {
      return;
    }
    setError(null);
    try {
      await onAdd(selectedId);
      setOpen(false);
    } catch (cause) {
      setError(apiErrorMessage(cause, "The participant could not be added."));
    }
  }

  const nobodyLeft = availableParticipants.length === 0;

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (isPending) {
          return;
        }
        // Cleared on the way *in*, never on the way out: clearing a filter while
        // the dialog is still animating away re-expands the list underneath it,
        // and the box visibly jumps to full height before it disappears.
        if (open) {
          reset();
        }
        setOpen(open);
      }}
    >
      <Button
        size="sm"
        variant="secondary"
        isDisabled={isDisabled || nobodyLeft}
      >
        <UserRoundPlus aria-hidden="true" className="size-4" />
        Add participant
      </Button>
      <Modal.Backdrop>
        <Modal.Container size="md" placement="center">
          <Modal.Dialog>
            <Modal.Header className="flex items-start justify-between gap-4">
              <Modal.Heading className="text-[1.05rem] font-bold tracking-tight text-ink">
                Add a participant
              </Modal.Heading>
              <Modal.CloseTrigger />
            </Modal.Header>
            <Modal.Body className="grid gap-4">
              <p className="text-sm text-ink-muted">
                Everyone already on this event is left out of the list. Adding
                someone marks them present; correct that in the table afterwards
                if they did not come.
              </p>

              <SearchField
                aria-label="Search participants"
                value={query}
                onChange={setQuery}
                fullWidth
              >
                <SearchField.Group>
                  <SearchField.SearchIcon>
                    <Search aria-hidden="true" className="size-4" />
                  </SearchField.SearchIcon>
                  <SearchField.Input placeholder="Name, email or phone…" />
                  <SearchField.ClearButton>
                    <X aria-hidden="true" className="size-4" />
                  </SearchField.ClearButton>
                </SearchField.Group>
              </SearchField>

              <ListBox
                aria-label="Participants who are not on this event"
                selectionMode="single"
                selectedKeys={selectedId === null ? [] : [selectedId]}
                onSelectionChange={(keys) => {
                  if (keys === "all") {
                    return;
                  }
                  const [first] = keys;
                  setSelectedId(first === undefined ? null : String(first));
                }}
                items={results}
                className="max-h-[19rem] overflow-y-auto"
                renderEmptyState={() => (
                  <p className="p-6 text-center text-sm text-ink-muted">
                    {nobodyLeft
                      ? "Everyone on file is already on this event."
                      : "Nobody matches that. Try a different name, email or phone."}
                  </p>
                )}
              >
                {/* Selection is painted from React Aria's own `data-selected`,
                    as the palette picker in `AdminUserMenu` does. Deriving it
                    from state instead would not show: the collection caches an
                    item's render, so a row does not re-render when the
                    selection outside it changes. */}
                {(participant: ParticipantDtoOutput) => (
                  <ListBox.Item
                    id={participant.id}
                    textValue={
                      participant.preferredName ?? participant.emailNormalized
                    }
                    className="group px-2 py-1.5 data-[selected]:bg-primary-soft"
                  >
                    <div className="flex w-full min-w-0 items-center justify-between gap-3">
                      <ParticipantIdentity
                        preferredName={participant.preferredName}
                        emailNormalized={participant.emailNormalized}
                      />
                      <span className="flex shrink-0 items-center gap-3">
                        {participant.phoneE164 ? (
                          <span className="inline-flex items-center gap-1.5 text-xs tabular-nums text-ink-muted">
                            <Phone aria-hidden="true" className="size-3.5" />
                            {participant.phoneE164}
                          </span>
                        ) : (
                          <span className="text-xs text-ink-subtle">
                            No phone
                          </span>
                        )}
                        {/* Always rendered, so choosing a row does not shift
                            the phone numbers beside it. */}
                        <Check
                          aria-hidden="true"
                          className="invisible size-4 text-primary group-data-[selected]:visible"
                        />
                      </span>
                    </div>
                  </ListBox.Item>
                )}
              </ListBox>

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
                isDisabled={isPending || selectedId === null}
                onPress={() => {
                  void handleAdd();
                }}
              >
                {isPending ? "Adding…" : "Add participant"}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
