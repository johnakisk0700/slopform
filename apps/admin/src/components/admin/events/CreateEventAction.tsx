import { Button, Input, Modal } from "@heroui/react";
import { CalendarPlus } from "lucide-react";
import { useId, useState } from "react";

import { apiErrorMessage } from "../../../lib/api";

interface CreateEventActionProps {
  isPending: boolean;
  /** Rejects on failure; the dialog keeps what was typed and shows the reason. */
  onCreate: (details: { title: string; startsAt: string }) => Promise<void>;
}

/**
 * «New event»: a dialog rather than the form that used to stand permanently
 * above the list. Creating an event is a handful of times a month; the list
 * underneath is read every day, and it was paying for the form's space on
 * every one of those days.
 */
export function CreateEventAction({
  isPending,
  onCreate,
}: CreateEventActionProps) {
  const titleId = useId();
  const startsAtId = useId();
  const [isOpen, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setTitle("");
    setStartsAt("");
    setError(null);
  }

  async function handleCreate() {
    if (title.trim() === "" || startsAt === "") {
      return;
    }
    setError(null);
    try {
      await onCreate({ title: title.trim(), startsAt });
      reset();
      setOpen(false);
    } catch (cause) {
      setError(apiErrorMessage(cause, "The event could not be created."));
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
      <Button size="sm" variant="secondary">
        <CalendarPlus aria-hidden="true" className="size-4" />
        New event
      </Button>
      <Modal.Backdrop>
        <Modal.Container size="sm" placement="center">
          <Modal.Dialog>
            <Modal.Header className="flex items-start justify-between gap-4">
              <Modal.Heading className="text-[1.05rem] font-bold tracking-tight text-ink">
                New event
              </Modal.Heading>
              <Modal.CloseTrigger />
            </Modal.Header>
            <Modal.Body className="grid gap-4">
              <p className="text-sm text-ink-muted">
                Starts as a draft. Add the people, schedule it, and finish it
                once it has happened.
              </p>

              <div className="grid gap-1.5">
                <label
                  htmlFor={titleId}
                  className="jts-overline text-ink-muted"
                >
                  Title
                </label>
                <Input
                  id={titleId}
                  value={title}
                  onChange={(change) => setTitle(change.target.value)}
                  disabled={isPending}
                  placeholder="Dinner at…"
                  className="w-full"
                />
              </div>

              <div className="grid gap-1.5">
                <label
                  htmlFor={startsAtId}
                  className="jts-overline text-ink-muted"
                >
                  Starts at
                </label>
                <Input
                  id={startsAtId}
                  type="datetime-local"
                  value={startsAt}
                  onChange={(change) => setStartsAt(change.target.value)}
                  disabled={isPending}
                  className="w-full"
                />
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
                isDisabled={isPending || title.trim() === "" || startsAt === ""}
                onPress={() => {
                  void handleCreate();
                }}
              >
                {isPending ? "Creating…" : "Create event"}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
