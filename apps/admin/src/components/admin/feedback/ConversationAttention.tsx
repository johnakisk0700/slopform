import { Button } from "@heroui/react";
import { ChevronDown, TriangleAlert } from "lucide-react";
import { useId } from "react";

import type { FeedbackConversationDetailDtoOutput } from "../../../api/generated/model/feedbackConversationDetailDtoOutput";
import { attentionReasonLabel } from "../../../features/feedback/labels";
import { revealTranscriptMessage } from "../../../features/feedback/revealTranscriptMessage";

interface ConversationAttentionProps {
  conversation: FeedbackConversationDetailDtoOutput;
  onDismiss: (reasonId: string) => Promise<void>;
  /** The reason being dismissed right now, so only its own row goes quiet. */
  dismissingReasonId: string | null;
}

/**
 * Above this many unresolved reasons the strip collapses into a disclosure so
 * five warnings do not push the transcript off the first screen. Two stay
 * open: that is still a short list an operator can read without clicking.
 */
const COLLAPSE_AFTER = 2;

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
 * a confirmation for each of a dozen possible reasons — is how a badge ends up
 * never being cleared, which is the state this whole list exists to end. That
 * is safe because it is per reason and reversible in the only sense that
 * matters: whatever raised it will raise it again on the next message.
 *
 * More than two unresolved reasons collapse into one disclosure. The strip is
 * a working surface for the transcript, not a stack of alerts that out-sizes
 * the messages it is about.
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
    // Scroll only inside the messages box (and pin the pane if needed) — never
    // ask the message itself to scroll the document. See revealTranscriptMessage.
    revealTranscriptMessage(messageId);
  }

  const reasonList = (
    <ul className="flex flex-col gap-0.5">
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
            className="flex min-h-7 flex-nowrap items-center justify-between gap-x-3"
          >
            <span className="flex min-w-0 items-center gap-1.5">
              <TriangleAlert
                aria-hidden="true"
                className="size-3.5 shrink-0 text-warning"
              />
              {anchor === null ? (
                <p className="min-w-0 truncate text-sm text-ink" title={label}>
                  {label}
                </p>
              ) : (
                <button
                  type="button"
                  onClick={() => showMessage(anchor)}
                  title={label}
                  className="min-w-0 truncate rounded-xs text-left text-sm text-ink underline decoration-warning-border decoration-1 underline-offset-2 hover:decoration-warning"
                >
                  {label}
                  <span className="sr-only">
                    {" "}
                    Show the message that caused it.
                  </span>
                </button>
              )}
            </span>
            {/* No xs size in HeroUI — compact the sm ghost down to the row
                height. text-ink is forced because the default ghost colour
                matches the warning tint and disappears. shrink-0 keeps
                Dismiss on the same line as a long truncated reason. */}
            <Button
              size="sm"
              variant="ghost"
              className="h-6 min-h-6 shrink-0 px-1.5 text-xs text-ink"
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
  );

  const collapsed = unresolved.length > COLLAPSE_AFTER;

  return (
    /* The same full-width tinted strip this pane already uses to say something
       is wrong (see the action error below the messages), rather than a card
       that would push the transcript down the screen. */
    <section
      aria-labelledby={headingId}
      className="relative z-[1] rounded-b-md border-b border-warning-border bg-warning-soft px-5 py-1 shadow-xs"
    >
      {/* The heading is for the accessibility tree only. On screen, the tinted
          strip and the triangle on every row already say "this needs
          attention" — a visible caption restated them and cost the transcript
          a row. */}
      <h3 id={headingId} className="sr-only">
        Why this needs attention
      </h3>
      {collapsed ? (
        <details className="jts-disclosure group">
          <summary className="flex min-h-7 cursor-pointer list-none items-center gap-1.5 text-sm text-ink marker:content-none [&::-webkit-details-marker]:hidden">
            <ChevronDown
              aria-hidden="true"
              className="size-3.5 shrink-0 text-warning transition-transform duration-200 group-open:rotate-180"
            />
            <TriangleAlert
              aria-hidden="true"
              className="size-3.5 shrink-0 text-warning"
            />
            <span className="font-medium">
              {unresolved.length} things need attention
            </span>
          </summary>
          <div className="pt-0.5">{reasonList}</div>
        </details>
      ) : (
        reasonList
      )}
    </section>
  );
}
