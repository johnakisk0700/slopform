import type { FeedbackCampaignConversationsDtoOutputConversationsItem } from "../../api/generated/model/feedbackCampaignConversationsDtoOutputConversationsItem";
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
export interface ConversationLike {
  goals: readonly { status: "pending" | "asked" | "answered" | "skipped" }[];
  lifecycle: { state: "open" | "closed"; reason: string | null };
  control: { mode: "bot" | "human" };
  needsAttention: boolean;
}

export interface GoalProgress {
  /** Goals with a recorded answer. */
  answered: number;
  /** Goals the participant explicitly skipped. */
  skipped: number;
  /** Goals that are neither answered nor skipped. */
  outstanding: number;
  total: number;
  /** Answered plus skipped, as a 0–100 integer. Zero when there are no goals. */
  percent: number;
}

export function goalProgress(goals: ConversationLike["goals"]): GoalProgress {
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
    total,
    percent: total === 0 ? 0 : Math.round((settled / total) * 100),
  };
}

/**
 * The badge row shown on a conversation: lifecycle, who is driving the reply,
 * and whether a human needs to look. Ordered by how much it should pull the
 * eye, most urgent last so it reads as the rightmost emphasis.
 */
export function conversationBadges(
  conversation: ConversationLike,
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
export function foldForSearch(value: string): string {
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

export interface ConversationGroup {
  key: "attention" | "open" | "closed";
  title: string;
  conversations: ConversationListItem[];
}

/**
 * Groups the filtered list into the three buckets an operator triages by.
 * Empty buckets are dropped so the list never renders a heading over nothing.
 */
export function groupConversations(
  conversations: readonly ConversationListItem[],
): ConversationGroup[] {
  const attention: ConversationListItem[] = [];
  const open: ConversationListItem[] = [];
  const closed: ConversationListItem[] = [];

  for (const conversation of conversations) {
    if (conversation.needsAttention) {
      attention.push(conversation);
    } else if (conversation.lifecycle.state === "open") {
      open.push(conversation);
    } else {
      closed.push(conversation);
    }
  }

  return [
    {
      key: "attention" as const,
      title: "Needs attention",
      conversations: attention,
    },
    { key: "open" as const, title: "Open", conversations: open },
    { key: "closed" as const, title: "Closed", conversations: closed },
  ].filter((group) => group.conversations.length > 0);
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
