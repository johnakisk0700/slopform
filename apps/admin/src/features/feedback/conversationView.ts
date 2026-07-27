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
 * The transcript header keeps the full `conversationBadges` set: it stands
 * alone, with no heading above it to inherit meaning from.
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
      return badge.label !== CONVERSATION_GROUP_TITLES[group];
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
