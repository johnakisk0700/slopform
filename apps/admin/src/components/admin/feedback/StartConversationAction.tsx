import { Button, ListBox, Modal, Select } from "@heroui/react";
import { UserPlus } from "lucide-react";
import { useMemo, useState } from "react";

import { useGetEvent } from "../../../api/generated/events";

export interface StartConversationActionProps {
  eventId: string;
  /** Participants who already have a conversation in this campaign. */
  existingParticipantIds: ReadonlySet<string>;
  isDisabled: boolean;
  isPending: boolean;
  onStart: (participantId: string) => Promise<void>;
}

/**
 * D17's «Start conversation»: opens a thread for an attendee the launch gate
 * missed, usually because they were marked present after the campaign started.
 *
 * Nothing about an event propagates into conversations automatically, so this
 * is a deliberate human action with an audit trail behind it. Candidates come
 * from the event's own attendee list, narrowed to people marked present who do
 * not already have a conversation — the backend still re-checks eligibility
 * (opt-in and a phone number) and refuses if it does not hold.
 */
export function StartConversationAction({
  eventId,
  existingParticipantIds,
  isDisabled,
  isPending,
  onStart,
}: StartConversationActionProps) {
  const [isOpen, setOpen] = useState(false);
  const [participantId, setParticipantId] = useState<string | null>(null);

  const eventQuery = useGetEvent(eventId, { query: { enabled: isOpen } });

  const candidates = useMemo(() => {
    const attendees = eventQuery.data?.attendees ?? [];
    return attendees.filter(
      (attendee) =>
        attendee.present && !existingParticipantIds.has(attendee.participantId),
    );
  }, [eventQuery.data?.attendees, existingParticipantIds]);

  async function handleConfirm() {
    if (participantId === null) {
      return;
    }
    await onStart(participantId);
    setParticipantId(null);
    setOpen(false);
  }

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!isPending) {
          setOpen(open);
          if (!open) {
            setParticipantId(null);
          }
        }
      }}
    >
      <Button size="sm" variant="secondary" isDisabled={isDisabled}>
        <UserPlus aria-hidden="true" className="size-4" />
        Start conversation
      </Button>
      <Modal.Backdrop>
        <Modal.Container size="sm" placement="center">
          <Modal.Dialog>
            <Modal.Header className="flex items-start justify-between gap-4">
              <Modal.Heading className="text-[1.05rem] font-bold tracking-tight text-ink">
                Start a conversation
              </Modal.Heading>
              <Modal.CloseTrigger />
            </Modal.Header>
            <Modal.Body className="grid gap-3">
              <p className="text-sm text-ink-muted">
                Opens a feedback conversation for an attendee who is marked
                present but has none yet, and queues their intro message.
              </p>

              {eventQuery.isPending ? (
                <p role="status" className="text-sm text-ink-muted">
                  Loading attendees…
                </p>
              ) : eventQuery.isError ? (
                <p role="alert" className="text-sm text-danger">
                  Could not load this event&rsquo;s attendees.
                </p>
              ) : candidates.length === 0 ? (
                <p className="text-sm text-ink-muted">
                  Every attendee marked present already has a conversation. Mark
                  someone present on the event first.
                </p>
              ) : (
                <Select
                  aria-label="Attendee"
                  placeholder="Select an attendee"
                  selectedKey={participantId}
                  onSelectionChange={(key) => {
                    setParticipantId(key === null ? null : String(key));
                  }}
                >
                  <Select.Trigger className="w-full">
                    <Select.Value />
                    <Select.Indicator />
                  </Select.Trigger>
                  <Select.Popover>
                    <ListBox>
                      {candidates.map((attendee) => {
                        const label =
                          attendee.preferredName ?? attendee.emailNormalized;
                        return (
                          <ListBox.Item
                            key={attendee.participantId}
                            id={attendee.participantId}
                            textValue={label}
                          >
                            {label}
                          </ListBox.Item>
                        );
                      })}
                    </ListBox>
                  </Select.Popover>
                </Select>
              )}
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
                isDisabled={isPending || participantId === null}
                onPress={() => {
                  void handleConfirm();
                }}
              >
                {isPending ? "Starting…" : "Start conversation"}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
