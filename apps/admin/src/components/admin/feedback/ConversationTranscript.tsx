import { Button, Chip, Input } from "@heroui/react";
import { clsx } from "clsx";
import {
  BellRing,
  Bot,
  Check,
  CheckCheck,
  Clock,
  Eye,
  FlaskConical,
  PauseCircle,
  Phone,
  Send,
  TriangleAlert,
  UserRound,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";

import type { FeedbackConversationDetailDtoOutput } from "../../../api/generated/model/feedbackConversationDetailDtoOutput";
import type { FeedbackConversationDetailDtoOutputMessagesItem } from "../../../api/generated/model/feedbackConversationDetailDtoOutputMessagesItem";
import {
  conversationBadges,
  formatTimestamp,
  transcriptMessageAnchorId,
} from "../../../features/feedback/conversationView";
import {
  actorLabel,
  awaitingDeliveryReason,
  deliveryBadge,
  isUnresolvedParticipant,
  messageAttentionActionLabel,
  messageAttentionCategoryLabel,
  participantLabel,
  type FeedbackDeliveryIcon,
  type FeedbackDeliveryStatus,
} from "../../../features/feedback/labels";
import { SIMULATOR_MESSAGE_MAX_LENGTH } from "../../../features/feedback/simulator";
import { staffCloseSummary } from "../../../features/feedback/staffClose";
import { JtsLiveIndicator } from "../../ui/JtsLiveIndicator";
import { ReadingStatus } from "./ConversationDetails";
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

/**
 * WhatsApp's own glyphs, because that is the app whose transcript this is. An
 * operator reading a clock, one tick or two already knows what they mean, and
 * nothing here has to teach a vocabulary the participant's screen has taught
 * them first.
 */
const DELIVERY_ICONS: Record<FeedbackDeliveryIcon, LucideIcon> = {
  queued: Clock,
  sending: Check,
  held: PauseCircle,
  delivered: CheckCheck,
  read: CheckCheck,
  failed: TriangleAlert,
  cancelled: X,
};

/**
 * How loudly an inline state paints. Deliberately quiet everywhere except
 * `held`, which is the one inline state that means somebody paused something
 * and the message is going nowhere until they unpause it. `read` gets the
 * accent the way a second blue tick does — it is the only state that says the
 * participant has actually looked.
 */
const DELIVERY_INLINE_TONES: Record<FeedbackDeliveryIcon, string> = {
  queued: "text-ink-subtle",
  sending: "text-ink-subtle",
  held: "text-warning",
  delivered: "text-ink-subtle",
  read: "text-primary",
  failed: "text-danger",
  cancelled: "text-ink-subtle",
};

/**
 * The delivery state as part of the line the message already has, rather than
 * as furniture beneath it.
 *
 * `title` carries the whole sentence for a waiting message; the visible detail
 * carries its point in three words. The dimmed bubble is the third reading and
 * the only one visible from across the room.
 */
function InlineDeliveryStatus({
  status,
  title,
}: {
  status: FeedbackDeliveryStatus;
  title: string | null;
}) {
  const Icon = DELIVERY_ICONS[status.icon];
  return (
    <>
      <span aria-hidden="true" className="text-ink-subtle">
        ·
      </span>
      <span
        className={clsx(
          "flex items-center gap-1 font-semibold tracking-normal normal-case",
          DELIVERY_INLINE_TONES[status.icon],
        )}
        {...(title ? { title } : {})}
      >
        <Icon aria-hidden="true" className="size-3.5 shrink-0" />
        {status.label}
        {status.detail ? (
          <span className="font-normal text-ink-subtle">{status.detail}</span>
        ) : null}
      </span>
    </>
  );
}

interface TranscriptMessageProps {
  message: FeedbackConversationDetailDtoOutputMessagesItem;
}

function TranscriptMessage({ message }: TranscriptMessageProps) {
  const styles = ACTOR_STYLES[message.actor];
  const delivery = deliveryBadge(message.delivery);
  const awaiting = awaitingDeliveryReason(message.delivery);
  const attention = message.attention;
  const ActionIcon = attention?.recommendedAction === "review" ? Eye : BellRing;

  return (
    /* Anchored and focusable so an attention reason can send the operator to
       the exact message that caused it. `tabIndex={-1}` keeps it out of the
       tab order — it is a destination, not a stop. */
    <li
      id={transcriptMessageAnchorId(message.id)}
      tabIndex={-1}
      className={clsx("flex scroll-my-4 flex-col gap-1", styles.row)}
    >
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 px-1 jts-overline">
        <span className={styles.label}>{actorLabel(message.actor)}</span>
        <time
          dateTime={message.at}
          className="font-semibold tracking-normal text-ink-subtle normal-case"
        >
          {formatTimestamp(message.at)}
        </time>
        {delivery?.placement === "inline" ? (
          <InlineDeliveryStatus status={delivery} title={awaiting} />
        ) : null}
      </p>
      <div
        className={clsx(
          "max-w-[min(42rem,85%)] rounded-lg px-3.5 py-2.5 text-sm",
          attention
            ? "rounded-bl-sm border border-warning-border bg-warning-soft text-ink"
            : styles.bubble,
          // Dimmed until it reaches the participant. The line below carries the
          // same fact in words, so the opacity is a second reading of it rather
          // than the only one.
          awaiting && "opacity-60",
        )}
      >
        <p className="whitespace-pre-wrap">{message.text}</p>
        {attention ? (
          /* Every item is `flex` so the chip is a flex item rather than an
             inline one. An inline-flex chip sits on its line box's baseline,
             and a chip whose first child is an icon reports the icon's edge as
             that baseline while a text-only chip reports the text's — which is
             why the category chips and the action chip sat on two different
             lines, a half-step apart, on the one row an operator reads before
             deciding whether to act. */
          <ul
            aria-label="Message attention signals"
            className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-warning-border pt-2"
          >
            {attention.categories.map((category) => (
              <li key={category} className="flex">
                <Chip color="warning" size="sm" variant="soft">
                  <Chip.Label>
                    {messageAttentionCategoryLabel(category)}
                  </Chip.Label>
                </Chip>
              </li>
            ))}
            <li className="flex">
              {/* The icon is the chip's own child, not a second flex layer
                  inside the label: `.chip` already centres its children and
                  owns the gap, so the action chip keeps the same height and
                  inner padding as the plain ones instead of an ad-hoc pair. */}
              <Chip
                color={
                  attention.recommendedAction === "urgent_human_follow_up"
                    ? "danger"
                    : "warning"
                }
                size="sm"
                variant="soft"
              >
                <ActionIcon aria-hidden="true" className="size-3.5 shrink-0" />
                <Chip.Label>
                  {messageAttentionActionLabel(attention.recommendedAction)}
                </Chip.Label>
              </Chip>
            </li>
          </ul>
        ) : null}
      </div>
      {/* Only the two states that never reach the participant keep a chip. The
          rest sit in the meta line above, where they cost no vertical space and
          cannot crowd out the message itself. */}
      {delivery?.placement === "badge" ? (
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
  /**
   * The unresolved attention reasons, if any — see `ConversationAttention`.
   * It sits above the messages rather than in the scroll container, so it
   * cannot scroll away from the operator it is addressing.
   */
  attention?: ReactNode;
  /**
   * The capability-gated conversation actions. They live at the foot of this
   * pane, on the line that says who may write here — see
   * `ConversationActions`.
   */
  actions?: ReactNode;
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
  attention,
  actions,
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
      className="flex max-h-[66vh] min-h-0 flex-col overflow-hidden rounded-md border border-border bg-surface"
    >
      {/* Who, on what number, in what state — then what may be done about it.
          The badges sit on the identity line rather than off in the top-right
          corner, where the live mark's reserved width left them floating with a
          gap they did not explain. */}
      <header className="border-b border-border px-5 py-3">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
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
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <span className="flex items-center gap-1.5 text-xs text-ink-muted tabular-nums">
                <Phone
                  aria-hidden="true"
                  className="size-3.5 shrink-0 text-ink-subtle"
                />
                {conversation.phoneAtLaunch}
              </span>
              <FeedbackBadges badges={conversationBadges(conversation)} />
            </div>
            {conversation.staffClose ? (
              <p className="mt-1.5 text-xs text-ink-muted">
                {staffCloseSummary(conversation.staffClose)}
              </p>
            ) : null}
          </div>
          <JtsLiveIndicator
            active={isRefreshing}
            label="This transcript refreshes automatically while the conversation is open."
          />
        </div>
      </header>

      {attention}

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
        {/* Who may write here, and how to change that, on one line. The
            sentence explains the composer below it and the buttons beside it
            are what alters it — the actions belong to this thread, so they sit
            at the foot of it rather than off in a corner of its header. */}
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-5 py-2.5">
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
            {/* With a composer below, its own placeholder already says who is
                writing; the sentence is only needed when there is none. */}
            {canSendStaffMessage ? null : (
              <p className="text-sm text-ink-muted">
                {conversation.lifecycle.state === "closed"
                  ? "Closed — no messages can be sent."
                  : "The bot is replying."}
              </p>
            )}
            <ReadingStatus conversation={conversation} />
          </div>
          {actions}
        </div>

        {canSendStaffMessage ? (
          <form
            onSubmit={handleStaffSubmit}
            className="flex gap-2 border-t border-border-subtle px-5 py-3"
          >
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
        ) : null}

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
