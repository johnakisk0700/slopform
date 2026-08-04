import { Button, Chip, Input } from "@heroui/react";
import { clsx } from "clsx";
import {
  Archive,
  Ban,
  BellRing,
  Bot,
  Check,
  CheckCheck,
  CircleCheck,
  CircleSlash,
  Clock,
  Eye,
  FlaskConical,
  PauseCircle,
  Phone,
  Send,
  SquareX,
  TimerOff,
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
import type { FeedbackCampaignDtoOutputStatus } from "../../../api/generated/model/feedbackCampaignDtoOutputStatus";
import {
  closedConversationLine,
  formatExactTimestamp,
  formatTimestamp,
  sameTranscriptMinute,
  transcriptMessageAnchorId,
} from "../../../features/feedback/conversationView";
import {
  actorLabel,
  awaitingDeliveryReason,
  deliveryBadge,
  isUnresolvedParticipant,
  lifecycleBadge,
  messageAttentionActionLabel,
  messageAttentionCategoryLabel,
  participantLabel,
  type FeedbackDeliveryIcon,
  type FeedbackDeliveryStatus,
} from "../../../features/feedback/labels";
import { SIMULATOR_MESSAGE_MAX_LENGTH } from "../../../features/feedback/simulator";
import { staffCloseSummary } from "../../../features/feedback/staffClose";
import {
  createSimulatorMessageDraft,
  createStaffMessageDraft,
  editSimulatorMessageDraft,
  editStaffMessageDraft,
  settleSimulatorMessageDraft,
  settleStaffMessageDraft,
} from "../../../features/feedback/staffMessageDraft";
import { JtsLiveIndicator } from "../../ui/JtsLiveIndicator";
import { ReadingStatus } from "./ConversationDetails";
import { FeedbackBadges } from "./FeedbackBadges";

/**
 * Per-actor treatment. Outbound sides (bot, staff) sit right against a filled
 * surface; the participant sits left on a plain card; system lines are
 * centred, quiet and full width. A run of messages names its actor in text at
 * its start (and `sr-only` on every bubble), so the alignment and tone are
 * reinforcement rather than the only channel.
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
    // Copper, to match `bot` naming its own tone above. This label was ink
    // while the accent measured 3.93:1 on surface; every theme now clears AA
    // for its accent, so the exception is gone.
    label: "text-copper",
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
 * The glyph beside a closed thread's state pill in the header. One per named
 * end, so the pill reads at a glance before its word does — the same
 * orientation duty icons carry everywhere else on this screen.
 */
const CLOSED_STATE_ICONS: Record<string, LucideIcon> = {
  completed: CircleCheck,
  declined: CircleSlash,
  stopped: Ban,
  expired: TimerOff,
  cancelled: SquareX,
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
  /**
   * True at the start of a run — the first message, or one whose actor differs
   * from the message above it. The visible actor label renders only there:
   * within a run the side and fill already carry the actor, and a caps label
   * on every bubble was the most repeated text on the screen. Continuations
   * keep an `sr-only` label, so a screen reader still hears every speaker.
   */
  startsRun: boolean;
  /** True when this message's minute differs from the one above it. */
  newMinute: boolean;
}

function TranscriptMessage({
  message,
  startsRun,
  newMinute,
}: TranscriptMessageProps) {
  const styles = ACTOR_STYLES[message.actor];
  const delivery = deliveryBadge(message.delivery);
  const awaiting = awaitingDeliveryReason(message.delivery);
  const attention = message.attention;
  const ActionIcon = attention?.recommendedAction === "review" ? Eye : BellRing;

  // Same actor, same minute → the meta line repeats everything the one above
  // it said, so it collapses, the way every messaging app groups its bubbles.
  // A press brings it back (the touch equivalent of the hover tooltip below),
  // and a delivery state someone must act on — held, failed — always forces
  // the line: a paused message must not be quieter than a delivered one.
  const [revealed, setRevealed] = useState(false);
  const deliveryDemandsMeta =
    delivery?.placement === "inline" &&
    (delivery.icon === "held" || delivery.icon === "failed");
  const showsMeta = startsRun || newMinute || deliveryDemandsMeta || revealed;

  return (
    /* Anchored and focusable so an attention reason can send the operator to
       the exact message that caused it. `tabIndex={-1}` keeps it out of the
       tab order — it is a destination, not a stop. */
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions -- The press is a touch-only convenience for revealing a grouped message's time: pointer users get the same fact from the bubble's `title` on hover, and assistive tech always has it in the meta line or its sr-only stand-in. A button role here would announce every message as a control.
    <li
      id={transcriptMessageAnchorId(message.id)}
      tabIndex={-1}
      onClick={() => setRevealed((current) => !current)}
      className={clsx("flex scroll-my-4 flex-col gap-1", styles.row)}
    >
      {showsMeta ? (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 px-1 jts-overline">
          {startsRun ? (
            <span className={styles.label}>{actorLabel(message.actor)}</span>
          ) : (
            <span className="sr-only">{actorLabel(message.actor)}</span>
          )}
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
      ) : (
        /* The collapsed line still speaks: a screen reader hears every actor
           and time in order, whatever the sighted grouping hides. */
        <p className="sr-only">
          {actorLabel(message.actor)} {formatTimestamp(message.at)}
        </p>
      )}
      <div
        title={formatExactTimestamp(message.at)}
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
  /** Current campaign state, so intentional pauses do not read as lost work. */
  campaignStatus: FeedbackCampaignDtoOutputStatus | null;
  /** Sends as staff — only offered while the server says control is human. */
  onStaffSend: (text: string, clientMessageId: string) => Promise<boolean>;
  staffSendPending: boolean;
  /**
   * Present only when the backend's dev simulator answers for this phone,
   * which is how the screen learns the transport is simulated (U2).
   */
  onSimulatedReply?: (text: string, idempotencyKey: string) => Promise<boolean>;
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
  campaignStatus,
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

  const [staffDraft, setStaffDraft] = useState(createStaffMessageDraft);
  const [simulatorDraft, setSimulatorDraft] = useState(
    createSimulatorMessageDraft,
  );
  const endRef = useRef<HTMLDivElement>(null);

  const name = participantLabel(conversation.respondentDisplayName);
  const unresolved = isUnresolvedParticipant(
    conversation.respondentDisplayName,
  );
  const capabilities = conversation.capabilities;
  const canSendStaffMessage = capabilities.canSendStaffMessage;
  // Presence checks only — whether each action exists is still the server's
  // capability flags, exactly as `ConversationActions` reads them. This just
  // keeps an empty foot row from renting a hairline and padding on a thread
  // where nothing can act any more.
  const hasConversationActions =
    capabilities.canTakeOver ||
    capabilities.canResumeBot ||
    capabilities.canClose;
  const botReplying =
    !canSendStaffMessage && conversation.lifecycle.state === "open";
  const closedLine = closedConversationLine(conversation);

  const lastMessageId = conversation.messages.at(-1)?.id ?? null;

  // Follow the conversation as it grows, including across polled refreshes and
  // when the operator switches threads.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [lastMessageId, conversation.id]);

  async function handleStaffSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = staffDraft.text.trim();
    if (text === "") {
      return;
    }
    const submittedClientMessageId = staffDraft.clientMessageId;
    const succeeded = await onStaffSend(text, submittedClientMessageId);
    setStaffDraft((current) =>
      settleStaffMessageDraft(current, submittedClientMessageId, succeeded),
    );
  }

  async function handleSimulatedSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = simulatorDraft.text.trim();
    if (text === "" || onSimulatedReply === undefined) {
      return;
    }
    const submittedIdempotencyKey = simulatorDraft.clientMessageId;
    const succeeded = await onSimulatedReply(text, submittedIdempotencyKey);
    setSimulatorDraft((current) =>
      settleSimulatorMessageDraft(current, submittedIdempotencyKey, succeeded),
    );
  }

  return (
    <section
      aria-labelledby={headingId}
      /* Viewport-anchored cap rather than the old 66vh: the compressed
         campaign header above the panes costs about 9rem including the main
         padding, so this hands the transcript everything under it instead of
         two thirds of the screen. The list pane carries the same value so the
         panes stay level. */
      className="flex max-h-[calc(100dvh-10rem)] min-h-0 flex-col overflow-hidden rounded-md border border-border bg-surface"
    >
      {/* The contact block every messaging app taught: name over number, two
          short lines. No badge row (density pass) — attention is the strip
          below with its reasons, who writes is the composer or the foot line.
          The one fact nothing else states, the named end of a closed thread,
          is an icon pill top-right where an operator glances for "can I still
          act here?"; its tooltip keeps the full sentence. */}
      <header className="border-b border-border px-5 py-2.5">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
          <div className="min-w-0">
            <h2
              id={headingId}
              className={clsx(
                "truncate text-[1.05rem] leading-tight font-bold tracking-tight text-ink",
                unresolved && "italic",
              )}
            >
              {name}
            </h2>
            <p className="mt-0.5 flex items-center gap-1.5 text-xs text-ink-muted tabular-nums">
              <Phone
                aria-hidden="true"
                className="size-3.5 shrink-0 text-ink-subtle"
              />
              {conversation.phoneAtLaunch}
            </p>
            {conversation.staffClose ? (
              <p className="mt-1 text-xs text-ink-muted">
                {staffCloseSummary(conversation.staffClose)}
              </p>
            ) : null}
          </div>
          {/* Indicator first, pill last: the live mark reserves its width even
              while idle, and with the pill inboard of it the pill hung half a
              step in from the corner beside an invisible gap. This way the
              pill sits flush in the corner, list-chip sized, and centred on
              the contact block rather than hanging off its first line. */}
          <div className="flex shrink-0 items-center gap-2">
            <JtsLiveIndicator
              active={isRefreshing}
              label="This transcript refreshes automatically while the conversation is open."
            />
            {closedLine ? (
              <div title={closedLine}>
                <FeedbackBadges
                  badges={[
                    {
                      ...lifecycleBadge({
                        state: conversation.lifecycle.state,
                        reason: conversation.lifecycle.reason as Parameters<
                          typeof lifecycleBadge
                        >[0]["reason"],
                      }),
                      glyph:
                        CLOSED_STATE_ICONS[
                          conversation.lifecycle.reason ?? ""
                        ] ?? Archive,
                    },
                  ]}
                />
              </div>
            ) : null}
          </div>
        </div>
      </header>

      {attention}

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {conversation.messages.length === 0 ? (
          <p className="py-8 text-center text-sm text-ink-muted">
            No messages yet. The intro is queued in the outbox.
          </p>
        ) : (
          <>
            <ul className="flex flex-col gap-4">
              {conversation.messages.map((message, index) => {
                const previous = conversation.messages[index - 1];
                return (
                  <TranscriptMessage
                    key={message.id}
                    message={message}
                    startsRun={previous?.actor !== message.actor}
                    newMinute={
                      previous === undefined ||
                      !sameTranscriptMinute(previous.at, message.at)
                    }
                  />
                );
              })}
            </ul>
            {/* The reading status ends the conversation the way a read receipt
                does: it is about these messages, so it sits under the last of
                them and scrolls with them, centred like the system lines. The
                auto-scroll lands past it, so its tinted states are on screen
                exactly when a reply has just arrived — the moment «why has the
                answer not appeared yet» gets asked. */}
            <div className="mt-4 flex justify-center">
              <ReadingStatus
                conversation={conversation}
                campaignStatus={campaignStatus}
              />
            </div>
          </>
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

      <div
        className={clsx(
          (botReplying ||
            hasConversationActions ||
            canSendStaffMessage ||
            onSimulatedReply !== undefined) &&
            "border-t border-border",
        )}
      >
        {/* Who may write here, and how to change that, on one line. The
            sentence explains the missing composer and the buttons beside it
            are what alters it — the actions belong to this thread, so they sit
            at the foot of it rather than off in a corner of its header. On a
            closed thread nothing can act, the header already says so, and the
            whole row disappears. */}
        {botReplying || hasConversationActions ? (
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-5 py-2.5">
            {/* With a composer below, its own placeholder already says who is
                writing; the sentence is only needed when there is none. */}
            {botReplying ? (
              <p className="text-sm text-ink-muted">The bot is replying.</p>
            ) : null}
            <div className="ml-auto">{actions}</div>
          </div>
        ) : null}

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
              value={staffDraft.text}
              onChange={(change) =>
                setStaffDraft((current) =>
                  editStaffMessageDraft(current, change.target.value),
                )
              }
              placeholder={`Reply to ${name} as staff…`}
              maxLength={SIMULATOR_MESSAGE_MAX_LENGTH}
              disabled={staffSendPending}
              className="flex-1 text-ink-muted"
            />
            <Button
              type="submit"
              isDisabled={staffSendPending || staffDraft.text.trim() === ""}
            >
              <Send aria-hidden="true" className="size-4" />
              {staffSendPending ? "Sending…" : "Send"}
            </Button>
          </form>
        ) : null}

        {onSimulatedReply ? (
          /* One compact row, not a captioned block: the dashed hairline, the
             sunken fill and the flask already say "not the real transport",
             and the full sentence lives on the label and the title. A dev
             affordance must not out-size the staff composer above it. */
          <form
            onSubmit={handleSimulatedSubmit}
            title="Development simulator — not a real WhatsApp message"
            className="flex items-center gap-2.5 border-t border-dashed border-border bg-surface-sunken px-5 py-2"
          >
            <p className="flex shrink-0 items-center gap-1.5 jts-overline text-ink-muted">
              <FlaskConical aria-hidden="true" className="size-3.5 shrink-0" />
              Dev
            </p>
            <label htmlFor={simulatorInputId} className="sr-only">
              Reply as {name} through the development simulator — not a real
              WhatsApp message
            </label>
            <Input
              id={simulatorInputId}
              value={simulatorDraft.text}
              onChange={(change) =>
                setSimulatorDraft((current) =>
                  editSimulatorMessageDraft(current, change.target.value),
                )
              }
              placeholder={`Reply as ${name} — simulated…`}
              maxLength={SIMULATOR_MESSAGE_MAX_LENGTH}
              disabled={simulatedReplyPending}
              className="min-w-0 flex-1 text-ink-muted"
            />
            <Button
              type="submit"
              size="sm"
              variant="secondary"
              isDisabled={
                simulatedReplyPending || simulatorDraft.text.trim() === ""
              }
            >
              {simulatedReplyPending ? "Injecting…" : "Inject"}
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
