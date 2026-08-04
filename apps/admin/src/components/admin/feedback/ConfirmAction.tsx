import { Button, Modal } from "@heroui/react";
import { clsx } from "clsx";
import { useState, type ReactNode } from "react";

interface ConfirmActionProps {
  /** Trigger label, also the accessible name of the opening button. */
  label: string;
  /** Dialog heading — name the action, not the outcome. */
  heading: string;
  /** What pressing confirm will actually do, in plain words. */
  description: ReactNode;
  /**
   * Extra controls the operator must fill before confirming — a reason select
   * on close, for example. Rendered under the description so the consequence
   * still leads.
   */
  children?: ReactNode;
  /** Label on the confirming button. */
  confirmLabel: string;
  /** `danger` for anything that closes, cancels or messages a participant. */
  tone?: "default" | "danger";
  isDisabled?: boolean;
  isPending?: boolean;
  /** Blocks confirm until a required field in `children` is filled. */
  isConfirmDisabled?: boolean;
  icon?: ReactNode;
  size?: "sm" | "md";
  /**
   * Renders the trigger as the icon alone, keeping `label` as its accessible
   * name. For a control that sits *inside* the thing it acts on — the × on a
   * person's pill — where a word would make the pill about its own button.
   */
  isIconOnly?: boolean;
  /**
   * Hide the visible label below this breakpoint and tighten the trigger to
   * icon-button proportions. `label` stays the accessible name. For a header
   * cluster that must share a line with a Greek full name on a phone.
   */
  collapseLabelAt?: "sm";
  /** Trigger styling for a control embedded in another surface. */
  triggerClassName?: string;
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
  children,
  confirmLabel,
  tone = "default",
  isDisabled = false,
  isPending = false,
  isConfirmDisabled = false,
  icon,
  size = "sm",
  isIconOnly = false,
  collapseLabelAt,
  triggerClassName,
  onConfirm,
}: ConfirmActionProps) {
  const [isOpen, setOpen] = useState(false);
  const needsAriaLabel = isIconOnly || collapseLabelAt !== undefined;

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
        {...(isIconOnly ? { isIconOnly: true } : {})}
        {...(needsAriaLabel ? { "aria-label": label } : {})}
        className={clsx(
          collapseLabelAt === "sm" && "max-sm:min-h-8 max-sm:min-w-8 max-sm:px-2",
          triggerClassName,
        )}
      >
        {icon}
        {isIconOnly ? null : (
          <span className={collapseLabelAt === "sm" ? "max-sm:hidden" : undefined}>
            {label}
          </span>
        )}
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
            <Modal.Body className="grid gap-4">
              <div className="text-sm text-ink-muted">{description}</div>
              {children}
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
                isDisabled={isPending || isConfirmDisabled}
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
