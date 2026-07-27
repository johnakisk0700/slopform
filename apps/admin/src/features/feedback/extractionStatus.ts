import type { FeedbackConversationDetailDtoOutputExtraction } from "../../api/generated/model/feedbackConversationDetailDtoOutputExtraction";
import { formatTimestamp } from "./conversationView";

/**
 * Greek copy for the extraction status block in the details pane.
 *
 * The backend reports only what it can prove: unread count from the document,
 * queue fields from retained BullMQ jobs. Absence of a job is left as
 * «άγνωστο» rather than «έτοιμο» — retention, a lost enqueue and "already ran"
 * look identical once the row is gone.
 */
export interface ExtractionStatusLines {
  /** Always present: how far behind the reading is, or that it is caught up. */
  unread: string;
  /** Schedule / failure / in-flight line. Null when there is nothing useful to say. */
  schedule: string | null;
  /** Quiet model provenance, when the document recorded one. */
  model: string | null;
  /** Whether the block should pull attention (unread backlog or failure). */
  attention: "none" | "pending" | "danger";
}

export function extractionStatusLines(
  extraction: FeedbackConversationDetailDtoOutputExtraction,
  now: Date = new Date(),
): ExtractionStatusLines {
  const unread =
    extraction.unreadParticipantMessages === 0
      ? "Όλα τα μηνύματα έχουν διαβαστεί."
      : extraction.unreadParticipantMessages === 1
        ? "1 μήνυμα δεν έχει διαβαστεί ακόμα."
        : `${extraction.unreadParticipantMessages} μηνύματα δεν έχουν διαβαστεί ακόμα.`;

  let schedule: string | null = null;
  let attention: ExtractionStatusLines["attention"] = "none";

  if (extraction.lastRunFailed) {
    schedule = "Η ανάγνωση απέτυχε · απάντησε η εναλλακτική διαδικασία.";
    attention = "danger";
  } else if (extraction.runInFlight) {
    // A time, not a spinner: a dead worker looks identical to a busy one.
    schedule = "Ανάγνωση σε εξέλιξη.";
    attention = extraction.unreadParticipantMessages > 0 ? "pending" : "none";
  } else if (extraction.nextRunAt) {
    schedule = `Επόμενη ανάγνωση ${formatTimestamp(extraction.nextRunAt, now)}.`;
    attention = extraction.unreadParticipantMessages > 0 ? "pending" : "none";
  } else if (extraction.runQueued) {
    schedule = "Ανάγνωση στην ουρά.";
    attention = extraction.unreadParticipantMessages > 0 ? "pending" : "none";
  } else if (extraction.unreadParticipantMessages > 0) {
    schedule = "Ώρα επόμενης ανάγνωσης άγνωστη.";
    attention = "pending";
  } else if (extraction.lastRunAt) {
    schedule = `Τελευταία ανάγνωση ${formatTimestamp(extraction.lastRunAt, now)}.`;
  }

  const model = extraction.model ? `Μοντέλο: ${extraction.model}` : null;

  return { unread, schedule, model, attention };
}
