import { Button, Chip, Input } from "@heroui/react";
import { clsx } from "clsx";
import {
  BellRing,
  Bot,
  Eye,
  FlaskConical,
  Phone,
  Send,
  UserRound,
} from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";

import type { FeedbackConversationDetailDtoOutput } from "../../../api/generated/model/feedbackConversationDetailDtoOutput";
import type { FeedbackConversationDetailDtoOutputMessagesItem } from "../../../api/generated/model/feedbackConversationDetailDtoOutputMessagesItem";
import {
  conversationBadges,
  formatTimestamp,
} from "../../../features/feedback/conversationView";
import {
  actorLabel,
  deliveryBadge,
  isUnresolvedParticipant,
  messageAttentionActionLabel,
  messageAttentionCategoryLabel,
  participantLabel,
} from "../../../features/feedback/labels";
import { SIMULATOR_MESSAGE_MAX_LENGTH } from "../../../features/feedback/simulator";
import { JtsLiveIndicator } from "../../ui/JtsLiveIndicator";
import { FeedbackBadges } from "./FeedbackBadges";

/**
 * Per-actor treatment. Outbound sides (bot, staff) sit right against a filled
 * surface; the participant sits left on a plain card; system lines are
 * centred, quiet and full width. Every bubble also names its actor in text, so
 * the alignment and tone are redundant rather than load-bearing.
 */
const ACTOR_STYLES: Record<
  FeedbackConversationDetailDtoOutputMessagesItem["actor"],
  { row: string; bubble: string; label: string }
> = {
  bot: {
    row: "items-end",
    bubble: "bg-primary-soft text-ink rounded-br-sm",
    label: "text-primary",
  },
  staff: {
    row: "items-end",
    bubble: "bg-copper-soft text-ink rounded-br-sm",
    // Not text-copper: the accent measures 3.93:1 on surface, under AA for a
    // 10px label. The copper bubble already marks the actor.
    label: "text-ink",
  },
  participant: {
    row: "items-start",
    bubble: "bg-surface-sunken text-ink rounded-bl-sm",
    label: "text-ink-muted",
  },
  system: {
    row: "items-center",
    bubble:
      "bg-transparent border border-dashed border-border text-ink-muted text-center",
    label: "text-ink-subtle",
  },
};

interface TranscriptMessageProps {
  message: FeedbackConversationDetailDtoOutputMessagesItem;
}

function TranscriptMessage({ message }: TranscriptMessageProps) {
  const styles = ACTOR_STYLES[message.actor];
  const delivery = deliveryBadge(message.delivery);
  const attention = message.attention;
  const ActionIcon = attention?.recommendedAction === "review" ? Eye : BellRing;

  return (
    <li className={clsx("flex flex-col gap-1", styles.row)}>
      <p className="flex items-center gap-2 px-1 jts-overline">
        <span className={styles.label}>{actorLabel(message.actor)}</span>
        <time
          dateTime={message.at}
          className="font-semibold tracking-normal text-ink-subtle normal-case"
        >
          {formatTimestamp(message.at)}
        </time>
      </p>
      <div
        className={clsx(
          "max-w-[min(42rem,85%)] rounded-lg px-3.5 py-2.5 text-sm",
          attention
            ? "rounded-bl-sm border border-warning-border bg-warning-soft text-ink"
            : styles.bubble,
        )}
      >
        <p className="whitespace-pre-wrap">{message.text}</p>
        {attention ? (
          <ul
            aria-label="Message attention signals"
            className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-warning-border pt-2"
          >
            {attention.categories.map((category) => (
              <li key={category}>
                <Chip color="warning" size="sm" variant="soft">
                  <Chip.Label>
                    {messageAttentionCategoryLabel(category)}
                  </Chip.Label>
                </Chip>
              </li>
            ))}
            <li>
              <Chip
                color={
                  attention.recommendedAction === "urgent_human_follow_up"
                    ? "danger"
                    : "warning"
                }
                size="sm"
                variant="soft"
              >
                <Chip.Label>
                  <span className="flex items-center gap-1">
                    <ActionIcon aria-hidden="true" className="size-3.5" />
                    {messageAttentionActionLabel(attention.recommendedAction)}
                  </span>
                </Chip.Label>
              </Chip>
            </li>
          </ul>
        ) : null}
      </div>
      {delivery ? (
        <FeedbackBadges
          badges={[delivery]}
          className="flex items-center gap-1.5 px-1"
        />
      ) : null}
    </li>
  );
}

interface ConversationTranscriptProps {
  conversation: FeedbackConversationDetailDtoOutput;
  /** Sends as staff — only offered while the server says control is human. */
  onStaffSend: (text: string) => Promise<void>;
  staffSendPending: boolean;
  /**
   * Present only when the backend's dev simulator answers for this phone,
   * which is how the screen learns the transport is simulated (U2).
   */
  onSimulatedReply?: (text: string) => Promise<void>;
  simulatedReplyPending?: boolean;
  actionError: string | null;
  /** True while the conversation query is refetching, for the live mark. */
  isRefreshing: boolean;
}

/**
 * The centre pane: the actor-labelled transcript plus whichever composer the
 * current state allows.
 *
 * Two composers can appear. The staff composer is gated purely on the server's
 * `canSendStaffMessage` capability. The «Reply as …» composer is a development
 * affordance that posts to the simulator's inject endpoint as the participant;
 * it is rendered only when that endpoint answered, and is labelled so nobody
 * mistakes it for a real WhatsApp message.
 */
export function ConversationTranscript({
  conversation,
  onStaffSend,
  staffSendPending,
  onSimulatedReply,
  simulatedReplyPending = false,
  actionError,
  isRefreshing,
}: ConversationTranscriptProps) {
  const headingId = useId();
  const staffInputId = useId();
  const simulatorInputId = useId();

  const [staffText, setStaffText] = useState("");
  const [simulatedText, setSimulatedText] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  const name = participantLabel(conversation.respondentDisplayName);
  const unresolved = isUnresolvedParticipant(
    conversation.respondentDisplayName,
  );
  const canSendStaffMessage = conversation.capabilities.canSendStaffMessage;

  const lastMessageId = conversation.messages.at(-1)?.id ?? null;

  // Follow the conversation as it grows, including across polled refreshes and
  // when the operator switches threads.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [lastMessageId, conversation.id]);

  async function handleStaffSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = staffText.trim();
    if (text === "") {
      return;
    }
    await onStaffSend(text);
    setStaffText("");
  }

  async function handleSimulatedSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = simulatedText.trim();
    if (text === "" || onSimulatedReply === undefined) {
      return;
    }
    await onSimulatedReply(text);
    setSimulatedText("");
  }

  return (
    <section
      aria-labelledby={headingId}
      className="flex max-h-[78vh] min-h-0 flex-col overflow-hidden rounded-md border border-border bg-surface"
    >
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-3">
        <div className="min-w-0">
          <h2
            id={headingId}
            className={clsx(
              "truncate text-[1.05rem] font-bold tracking-tight text-ink",
              unresolved && "italic",
            )}
          >
            {name}
          </h2>
          <p className="flex items-center gap-1.5 text-xs text-ink-muted">
            <Phone
              aria-hidden="true"
              className="size-3.5 shrink-0 text-ink-subtle"
            />
            {conversation.phoneAtLaunch}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <FeedbackBadges badges={conversationBadges(conversation)} />
          <JtsLiveIndicator
            active={isRefreshing}
            label="This transcript refreshes automatically while the conversation is open."
          />
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {conversation.messages.length === 0 ? (
          <p className="py-8 text-center text-sm text-ink-muted">
            No messages yet. The intro is queued in the outbox.
          </p>
        ) : (
          <ul className="flex flex-col gap-4">
            {conversation.messages.map((message) => (
              <TranscriptMessage key={message.id} message={message} />
            ))}
          </ul>
        )}
        <div ref={endRef} />
      </div>

      {actionError ? (
        <p
          role="alert"
          className="border-t border-border bg-danger-soft px-5 py-2 text-sm text-danger"
        >
          {actionError}
        </p>
      ) : null}

      <div className="border-t border-border">
        {canSendStaffMessage ? (
          <form onSubmit={handleStaffSubmit} className="flex gap-2 px-5 py-3">
            <label htmlFor={staffInputId} className="sr-only">
              Message to {name}, sent as staff
            </label>
            <Input
              id={staffInputId}
              value={staffText}
              onChange={(change) => setStaffText(change.target.value)}
              placeholder={`Reply to ${name} as staff…`}
              maxLength={SIMULATOR_MESSAGE_MAX_LENGTH}
              disabled={staffSendPending}
              className="flex-1"
            />
            <Button
              type="submit"
              isDisabled={staffSendPending || staffText.trim() === ""}
            >
              <Send aria-hidden="true" className="size-4" />
              {staffSendPending ? "Sending…" : "Send"}
            </Button>
          </form>
        ) : (
          <p className="px-5 py-3 text-sm text-ink-muted">
            {conversation.lifecycle.state === "closed"
              ? "This conversation is closed. No messages can be sent."
              : "Take over the conversation to reply as staff."}
          </p>
        )}

        {onSimulatedReply ? (
          <form
            onSubmit={handleSimulatedSubmit}
            className="flex flex-wrap items-center gap-2 border-t border-dashed border-border bg-surface-sunken px-5 py-3"
          >
            <p className="flex w-full items-center gap-2 jts-overline text-ink-muted">
              <FlaskConical aria-hidden="true" className="size-3.5" />
              Development simulator — not a real WhatsApp message
            </p>
            <label htmlFor={simulatorInputId} className="sr-only">
              Reply as {name} through the development simulator
            </label>
            <Input
              id={simulatorInputId}
              value={simulatedText}
              onChange={(change) => setSimulatedText(change.target.value)}
              placeholder={`Reply as ${name}…`}
              maxLength={SIMULATOR_MESSAGE_MAX_LENGTH}
              disabled={simulatedReplyPending}
              className="min-w-0 flex-1"
            />
            <Button
              type="submit"
              variant="secondary"
              isDisabled={simulatedReplyPending || simulatedText.trim() === ""}
            >
              {simulatedReplyPending ? "Injecting…" : `Reply as ${name}`}
            </Button>
          </form>
        ) : null}
      </div>
    </section>
  );
}

/** Placeholder shown while no conversation is selected. */
export function ConversationTranscriptEmpty() {
  return (
    <section className="flex min-h-0 flex-col items-center justify-center gap-3 rounded-md border border-border bg-surface p-10 text-center">
      <span aria-hidden="true" className="flex gap-2 text-ink-subtle">
        <Bot className="size-6" />
        <UserRound className="size-6" />
      </span>
      <p className="text-sm font-semibold text-ink">No conversation selected</p>
      <p className="max-w-[32ch] text-sm text-ink-muted">
        Pick a conversation from the list to read its transcript and act on it.
      </p>
    </section>
  );
}
