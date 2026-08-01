import type { FeedbackCampaignConversationsDtoOutputConversationsItem } from "../../api/generated/model/feedbackCampaignConversationsDtoOutputConversationsItem";
import type { FeedbackConversationDetailDtoOutputControlMode } from "../../api/generated/model/feedbackConversationDetailDtoOutputControlMode";
import type { FeedbackConversationDetailDtoOutputGoalsItemStatus } from "../../api/generated/model/feedbackConversationDetailDtoOutputGoalsItemStatus";
import type { FeedbackConversationDetailDtoOutputLifecycleState } from "../../api/generated/model/feedbackConversationDetailDtoOutputLifecycleState";
import {
  controlLabel,
  lifecycleBadge,
  participantLabel,
  type FeedbackBadge,
} from "./labels";

/**
 * Pure view models for the conversations inbox.
 *
 * Everything here is derived from a server read model; nothing decides what an
 * operator may do. Action availability comes from the per-conversation
 * capability flags the backend publishes, never from rules re-implemented here.
 */

export type ConversationListItem =
  FeedbackCampaignConversationsDtoOutputConversationsItem;

/** The subset of a conversation the progress and badge helpers need. */
export interface ConversationStatusFields {
  goals: readonly {
    status: FeedbackConversationDetailDtoOutputGoalsItemStatus;
  }[];
  lifecycle: {
    state: FeedbackConversationDetailDtoOutputLifecycleState;
    reason: string | null;
  };
  control: { mode: FeedbackConversationDetailDtoOutputControlMode };
  needsAttention: boolean;
}

export interface GoalProgress {
  /** Goals with a recorded answer. */
  answered: number;
  /** Goals the participant explicitly skipped. */
  skipped: number;
  /** Goals that are neither answered nor skipped. */
  outstanding: number;
  /**
   * Goals the questionnaire is finished with: answered plus skipped. It is the
   * one number an inbox row shows, which is why it is named for what it counts
   * — «2/4 answered» would have claimed two answers where one was a skip.
   */
  settled: number;
  total: number;
}

export function goalProgress(
  goals: ConversationStatusFields["goals"],
): GoalProgress {
  const total = goals.length;
  let answered = 0;
  let skipped = 0;

  for (const goal of goals) {
    if (goal.status === "answered") {
      answered += 1;
    } else if (goal.status === "skipped") {
      skipped += 1;
    }
  }

  const settled = answered + skipped;
  return {
    answered,
    skipped,
    outstanding: total - settled,
    settled,
    total,
  };
}

/**
 * The badge row shown on a conversation: lifecycle, who is driving the reply,
 * and whether a human needs to look. Ordered by how much it should pull the
 * eye, most urgent last so it reads as the rightmost emphasis.
 */
export function conversationBadges(
  conversation: ConversationStatusFields,
): FeedbackBadge[] {
  const badges: FeedbackBadge[] = [
    lifecycleBadge({
      state: conversation.lifecycle.state,
      reason: conversation.lifecycle.reason as Parameters<
        typeof lifecycleBadge
      >[0]["reason"],
    }),
  ];

  if (conversation.control.mode === "human") {
    badges.push({
      key: "control",
      label: controlLabel("human"),
      tone: "accent",
    });
  }

  if (conversation.needsAttention) {
    // The one badge that means "stop and read this": a safety disclosure or an
    // extraction that died without recording anything. It is emphasised rather
    // than merely coloured so it separates from the lifecycle chip beside it.
    badges.push({
      key: "attention",
      label: "Needs attention",
      tone: "warning",
      emphasis: "strong",
    });
  }

  return badges;
}

/**
 * The transcript header's quiet closed line: the thread's named end in words —
 * «Completed — no messages can be sent.» — where a row of pills used to sit.
 *
 * Null while the conversation is open, because an open thread already states
 * itself through the pane: the composer or the «bot is replying» line says who
 * writes, and the attention strip says what wants a person. The pills repeated
 * all of that at the top of the pane; the one fact nothing else stated was the
 * named closing reason, so that is what the header keeps.
 */
export function closedConversationLine(
  conversation: ConversationStatusFields,
): string | null {
  if (conversation.lifecycle.state !== "closed") {
    return null;
  }
  const { label } = lifecycleBadge({
    state: conversation.lifecycle.state,
    reason: conversation.lifecycle.reason as Parameters<
      typeof lifecycleBadge
    >[0]["reason"],
  });
  return `${label} — no messages can be sent.`;
}

/**
 * Free-text filter over the visible identity of a conversation: respondent
 * name and the phone it launched against. Accent- and case-insensitive so
 * "κωστας" finds «Κώστας», matching the STOP matcher's folding rule (D14).
 */
function foldForSearch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase("el");
}

export function matchesConversationQuery(
  conversation: Pick<
    ConversationListItem,
    "respondentDisplayName" | "phoneAtLaunch"
  >,
  query: string,
): boolean {
  const needle = foldForSearch(query.trim());
  if (needle === "") {
    return true;
  }

  const haystack = foldForSearch(
    `${participantLabel(conversation.respondentDisplayName)} ${conversation.phoneAtLaunch}`,
  );
  return haystack.includes(needle);
}

/**
 * Inbox order: conversations wanting a human first, then the most recent
 * activity. A stable id tiebreak keeps the list from reshuffling under
 * polling when two rows share a timestamp.
 */
export function sortConversationsForInbox(
  conversations: readonly ConversationListItem[],
): ConversationListItem[] {
  return [...conversations].sort((left, right) => {
    if (left.needsAttention !== right.needsAttention) {
      return left.needsAttention ? -1 : 1;
    }

    const leftAt = left.lastMessageAt ?? left.createdAt;
    const rightAt = right.lastMessageAt ?? right.createdAt;
    if (leftAt !== rightAt) {
      return leftAt < rightAt ? 1 : -1;
    }

    return left.id < right.id ? -1 : 1;
  });
}

export type ConversationGroupKey = "attention" | "open" | "closed";

export interface ConversationGroup {
  key: ConversationGroupKey;
  title: string;
  conversations: ConversationListItem[];
}

/**
 * The heading each bucket renders. It is also what `conversationRowBadges`
 * measures a row's badges against, so a title and the redundancy it creates
 * can never drift apart.
 */
export const CONVERSATION_GROUP_TITLES: Record<ConversationGroupKey, string> = {
  attention: "Needs attention",
  open: "Open",
  closed: "Closed",
};

/**
 * Groups the filtered list into the three buckets an operator triages by.
 * Empty buckets are dropped so the list never renders a heading over nothing.
 */
export function groupConversations(
  conversations: readonly ConversationListItem[],
): ConversationGroup[] {
  const buckets: Record<ConversationGroupKey, ConversationListItem[]> = {
    attention: [],
    open: [],
    closed: [],
  };

  for (const conversation of conversations) {
    if (conversation.needsAttention) {
      buckets.attention.push(conversation);
    } else if (conversation.lifecycle.state === "open") {
      buckets.open.push(conversation);
    } else {
      buckets.closed.push(conversation);
    }
  }

  return (["attention", "open", "closed"] as const)
    .map((key) => ({
      key,
      title: CONVERSATION_GROUP_TITLES[key],
      conversations: buckets[key],
    }))
    .filter((group) => group.conversations.length > 0);
}

/**
 * The badges a row still needs once its own heading has spoken.
 *
 * A conversation filed under NEEDS ATTENTION does not repeat «Needs attention»,
 * and no row repeats a lifecycle its heading already states — «Open» under
 * OPEN, the bare «Closed» under CLOSED. A *named* closing reason survives
 * anywhere, because «Stopped» is news the heading does not carry; so does human
 * control. What is left is only ever the exceptional, which is what makes a
 * chip in this list worth looking at.
 *
 * The transcript header renders no badge row at all (density pass,
 * 2026-08-01): every fact the pills carried is stated once, in the place it
 * acts — see `closedConversationLine`. This filter's full-set starting point
 * is `conversationBadges`, which the rows alone consume now.
 */
export function conversationRowBadges(
  conversation: ConversationStatusFields,
  group: ConversationGroupKey,
): FeedbackBadge[] {
  return conversationBadges(conversation).filter((badge) => {
    if (badge.key === "attention") {
      return group !== "attention";
    }
    if (badge.key === "lifecycle") {
      if (badge.label === CONVERSATION_GROUP_TITLES[group]) {
        return false;
      }
      // A group's expected state is not news either: an attention row is
      // ordinarily still open, and «Completed» is the ordinary end of a
      // closed thread. Absence states the normal case; the chip is left for
      // the exception — a «Stopped» thread nobody can reply to any more, a
      // decline, an expiry — which is what keeps a run of green «Completed»
      // chips from wallpapering the archive.
      if (group === "attention" && badge.label === "Open") {
        return false;
      }
      if (group === "closed" && badge.label === "Completed") {
        return false;
      }
    }
    return true;
  });
}

/**
 * Picks the conversation the screen should show. Keeps the operator's choice
 * whenever it survives the current filter — polling must never move the
 * selection out from under someone reading a transcript.
 */
export function resolveSelectedConversationId(
  visible: readonly ConversationListItem[],
  requested: string | null,
): string | null {
  if (requested !== null && visible.some((row) => row.id === requested)) {
    return requested;
  }
  return visible[0]?.id ?? null;
}

/**
 * The DOM id a transcript message carries, so an attention reason can link to
 * the message that caused it. One function for both ends of that link, so the
 * anchor and the thing pointing at it cannot drift apart.
 */
export function transcriptMessageAnchorId(messageId: string): string {
  return `transcript-message-${messageId}`;
}

/**
 * Whether two transcript messages land in the same minute, which is the
 * grouping the transcript collapses meta lines by: within a run of one actor,
 * a second message in the same minute repeats everything its line would say.
 */
export function sameTranscriptMinute(aIso: string, bIso: string): boolean {
  const a = new Date(aIso);
  const b = new Date(bIso);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) {
    return false;
  }
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate() &&
    a.getHours() === b.getHours() &&
    a.getMinutes() === b.getMinutes()
  );
}

/**
 * The full timestamp a collapsed message reveals on hover or press — date and
 * seconds included, because it answers "when exactly", not "roughly where in
 * the thread".
 */
export function formatExactTimestamp(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) {
    return "—";
  }
  return at.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** Short absolute timestamp for transcript lines and list rows. */
export function formatTimestamp(iso: string, now: Date = new Date()): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) {
    return "—";
  }

  const sameDay =
    at.getFullYear() === now.getFullYear() &&
    at.getMonth() === now.getMonth() &&
    at.getDate() === now.getDate();

  return at.toLocaleString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    ...(sameDay ? {} : { day: "2-digit", month: "short" }),
  });
}

/**
 * The same clock as `formatTimestamp`, down to the millisecond —
 * `17:03:59.472`.
 *
 * A transcript is read as a conversation, where the minute is the useful unit
 * and seconds would be noise. A delivery record is read as evidence: two
 * decisions 67 seconds apart, a row written and leased inside the same second,
 * a provider call that landed between two polls. The minute flattens every one
 * of those, so the forensic surfaces get their own formatter rather than
 * changing what the whole admin means by a time.
 */
export function formatPreciseTimestamp(
  iso: string,
  now: Date = new Date(),
): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) {
    return "—";
  }

  const sameDay =
    at.getFullYear() === now.getFullYear() &&
    at.getMonth() === now.getMonth() &&
    at.getDate() === now.getDate();

  return at.toLocaleString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
    ...(sameDay ? {} : { day: "2-digit", month: "short" }),
  });
}
