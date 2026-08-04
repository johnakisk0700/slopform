import type { FeedbackConversationDetailDtoOutputAutomation } from "../../api/generated/model/feedbackConversationDetailDtoOutputAutomation";
import { formatTimestamp } from "./conversationView";

/**
 * Durable scheduling facts published by the conversation aggregate.
 *
 * This is deliberately about work the conversation owes, not about whether a
 * particular Redis job happens to be retained. `revision` is useful for
 * diagnostics but never becomes a user-facing job id, and claim tokens/epochs
 * do not cross the HTTP boundary at all.
 */
export type ConversationAutomationStatus =
  FeedbackConversationDetailDtoOutputAutomation;

export type ReadingAutomationConstraint =
  | "none"
  | "conversation_closed"
  | "human_control"
  | "campaign_paused"
  | "campaign_closed";

export interface ReadingStatusInput {
  unreadParticipantMessages: number;
  lastRunAt: string | null;
  model: string | null;
  automation: ConversationAutomationStatus;
  /** Current state that intentionally forbids new automated work. */
  constraint: ReadingAutomationConstraint;
}

/**
 * Greek copy for the reading-status block in the details pane.
 *
 * Scheduling comes from the conversation's durable automation state. Redis
 * retention and job identity are deliberately outside this operator view.
 */
export interface ReadingStatusLines {
  /** Always present: how far behind the reading is, or that it is caught up. */
  unread: string;
  /** Schedule / failure / in-flight line. Null when there is nothing useful to say. */
  schedule: string | null;
  /** Quiet model provenance, when the document recorded one. */
  model: string | null;
  /** Whether the block should pull attention (unread backlog or failure). */
  attention: "none" | "pending" | "danger";
}

export function readingStatusLines(
  input: ReadingStatusInput,
  now: Date = new Date(),
): ReadingStatusLines {
  const unread = unreadLine(input.unreadParticipantMessages);
  const hasUnread = input.unreadParticipantMessages > 0;
  let schedule: string | null = null;
  let attention: ReadingStatusLines["attention"] = "none";

  if (input.constraint !== "none") {
    schedule = CONSTRAINT_COPY[input.constraint];
    attention = hasUnread
      ? input.constraint === "conversation_closed" ||
        input.constraint === "campaign_closed"
        ? "danger"
        : "pending"
      : "none";
  } else {
    switch (input.automation.state) {
      case "running":
        schedule = input.automation.claimExpiresAt
          ? `Ανάγνωση σε εξέλιξη · ενεργή ανάθεση έως ${formatTimestamp(input.automation.claimExpiresAt, now)}.`
          : "Ανάγνωση σε εξέλιξη.";
        attention = hasUnread ? "pending" : "none";
        break;
      case "scheduled":
        schedule = input.automation.nextActionAt
          ? `Επόμενη αυτόματη ενέργεια ${formatTimestamp(input.automation.nextActionAt, now)}.`
          : "Η επόμενη αυτόματη ενέργεια έχει προγραμματιστεί.";
        attention = hasUnread ? "pending" : "none";
        break;
      case "parked":
        schedule = input.automation.nextActionAt
          ? `Η ανάγνωση έχει παρκάρει · επόμενος έλεγχος ${formatTimestamp(input.automation.nextActionAt, now)}.`
          : "Η ανάγνωση έχει παρκάρει και περιμένει ανάκτηση.";
        attention = "danger";
        break;
      case "idle":
        if (hasUnread) {
          schedule = "Δεν έχει προγραμματιστεί επόμενη αυτόματη ενέργεια.";
          attention = "danger";
        } else if (input.lastRunAt) {
          schedule = `Τελευταία ανάγνωση ${formatTimestamp(input.lastRunAt, now)}.`;
        }
        break;
    }
  }

  const model = input.model ? `Μοντέλο: ${input.model}` : null;
  return { unread, schedule, model, attention };
}

const CONSTRAINT_COPY: Record<
  Exclude<ReadingAutomationConstraint, "none">,
  string
> = {
  conversation_closed: "Καμία νέα αυτόματη ενέργεια: η συζήτηση έχει κλείσει.",
  human_control:
    "Καμία νέα αυτόματη ενέργεια όσο τη συζήτηση χειρίζεται άνθρωπος.",
  campaign_paused: "Καμία νέα αυτόματη ενέργεια όσο η καμπάνια είναι σε παύση.",
  campaign_closed: "Καμία νέα αυτόματη ενέργεια: η καμπάνια έχει κλείσει.",
};

function unreadLine(unreadParticipantMessages: number): string {
  if (unreadParticipantMessages === 0) {
    return "Όλα τα μηνύματα έχουν διαβαστεί.";
  }
  if (unreadParticipantMessages === 1) {
    return "1 μήνυμα δεν έχει διαβαστεί ακόμα.";
  }
  return `${unreadParticipantMessages} μηνύματα δεν έχουν διαβαστεί ακόμα.`;
}
