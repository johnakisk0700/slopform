import { Button } from "@heroui/react";
import { TriangleAlert } from "lucide-react";
import { useId } from "react";

import type { FeedbackConversationDetailDtoOutput } from "../../../api/generated/model/feedbackConversationDetailDtoOutput";
import { transcriptMessageAnchorId } from "../../../features/feedback/conversationView";
import { attentionReasonLabel } from "../../../features/feedback/labels";

interface ConversationAttentionProps {
  conversation: FeedbackConversationDetailDtoOutput;
  onDismiss: (reasonId: string) => Promise<void>;
  /** The reason being dismissed right now, so only its own row goes quiet. */
  dismissingReasonId: string | null;
}

/**
 * Why this conversation is asking for a person, and how to make each reason go
 * away.
 *
 * It renders at the head of the transcript because every line here is about
 * these messages, and it renders nothing at all when there is nothing
 * unresolved — chrome that is always present is chrome an operator stops
 * reading. Resolved reasons are gone from the pane entirely; the audit row is
 * where "who cleared this" is kept, not the operator's working surface.
 *
 * Dismissing takes one press. No dialog and no note: by the time somebody
 * clicks they have read the message the reason links to, and the alternative —
 * a confirmation for each of five possible reasons — is how a badge ends up
 * never being cleared, which is the state this whole list exists to end. That
 * is safe because it is per reason and reversible in the only sense that
 * matters: whatever raised it will raise it again on the next message.
 */
export function ConversationAttention({
  conversation,
  onDismiss,
  dismissingReasonId,
}: ConversationAttentionProps) {
  const headingId = useId();
  const unresolved = conversation.attentionReasons.filter(
    (reason) => reason.resolvedAt === null,
  );

  if (unresolved.length === 0) {
    return null;
  }

  // A reason can name a message the transcript is not showing — the document
  // keeps only the last 150 — and a link that scrolls nowhere is worse than
  // the sentence on its own.
  const rendered = new Set(conversation.messages.map((message) => message.id));

  function showMessage(messageId: string) {
    const element = document.getElementById(
      transcriptMessageAnchorId(messageId),
    );
    if (element === null) {
      return;
    }
    element.scrollIntoView({ block: "center" });
    // Focus follows the scroll so the keyboard and a screen reader land on the
    // message too, rather than only the sighted operator's eye.
    element.focus({ preventScroll: true });
  }

  return (
    /* The same full-width tinted strip this pane already uses to say something
       is wrong (see the action error below the messages), rather than a card
       that would push the transcript down the screen. */
    <section
      aria-labelledby={headingId}
      className="border-b border-warning-border bg-warning-soft px-5 py-2.5"
    >
      <h3
        id={headingId}
        className="flex items-center gap-1.5 jts-overline text-warning"
      >
        <TriangleAlert aria-hidden="true" className="size-3.5 shrink-0" />
        Why this needs attention
      </h3>
      <ul className="mt-1">
        {unresolved.map((reason) => {
          const label = attentionReasonLabel(reason.kind);
          const anchor =
            reason.messageId !== null && rendered.has(reason.messageId)
              ? reason.messageId
              : null;
          const dismissing = dismissingReasonId === reason.id;

          return (
            <li
              key={reason.id}
              className="flex flex-wrap items-center justify-between gap-x-3"
            >
              {anchor === null ? (
                <p className="min-w-0 text-sm text-ink">{label}</p>
              ) : (
                <button
                  type="button"
                  onClick={() => showMessage(anchor)}
                  className="min-w-0 rounded-xs text-left text-sm text-ink underline decoration-warning-border decoration-1 underline-offset-2 hover:decoration-warning"
                >
                  {label}
                  <span className="sr-only">
                    {" "}
                    Show the message that caused it.
                  </span>
                </button>
              )}
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Dismiss: ${label}`}
                isDisabled={dismissing}
                onPress={() => {
                  void onDismiss(reason.id);
                }}
              >
                {dismissing ? "Dismissing…" : "Dismiss"}
              </Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
