import { Button, Modal } from "@heroui/react";
import { useState, type ReactNode } from "react";

export interface ConfirmActionProps {
  /** Trigger label, also the accessible name of the opening button. */
  label: string;
  /** Dialog heading — name the action, not the outcome. */
  heading: string;
  /** What pressing confirm will actually do, in plain words. */
  description: ReactNode;
  /** Label on the confirming button. */
  confirmLabel: string;
  /** `danger` for anything that closes, cancels or messages a participant. */
  tone?: "default" | "danger";
  isDisabled?: boolean;
  isPending?: boolean;
  icon?: ReactNode;
  size?: "sm" | "md";
  onConfirm: () => Promise<void>;
}

/**
 * A trigger plus its confirmation dialog for one conversation or campaign
 * action.
 *
 * Every action on this screen is observable by a participant — it takes a
 * thread away from the bot, sends a WhatsApp message, or closes a
 * conversation — so none of them fire on a single press. The dialog states the
 * consequence rather than asking "are you sure?", and closes only after the
 * mutation settles so a failure keeps the operator in context.
 */
export function ConfirmAction({
  label,
  heading,
  description,
  confirmLabel,
  tone = "default",
  isDisabled = false,
  isPending = false,
  icon,
  size = "sm",
  onConfirm,
}: ConfirmActionProps) {
  const [isOpen, setOpen] = useState(false);

  async function handleConfirm() {
    await onConfirm();
    setOpen(false);
  }

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={(open) => {
        // Never let a backdrop press dismiss an in-flight action.
        if (!isPending) {
          setOpen(open);
        }
      }}
    >
      <Button
        size={size}
        variant={tone === "danger" ? "danger-soft" : "secondary"}
        isDisabled={isDisabled}
      >
        {icon}
        {label}
      </Button>
      <Modal.Backdrop>
        <Modal.Container size="sm" placement="center">
          <Modal.Dialog>
            <Modal.Header className="flex items-start justify-between gap-4">
              <Modal.Heading className="text-[1.05rem] font-bold tracking-tight text-ink">
                {heading}
              </Modal.Heading>
              <Modal.CloseTrigger />
            </Modal.Header>
            <Modal.Body>
              <div className="text-sm text-ink-muted">{description}</div>
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
                variant={tone === "danger" ? "danger" : "primary"}
                isDisabled={isPending}
                onPress={() => {
                  void handleConfirm();
                }}
              >
                {isPending ? "Working…" : confirmLabel}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
