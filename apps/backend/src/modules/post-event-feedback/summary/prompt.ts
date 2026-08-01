import type {
  FeedbackAnswerRow,
  FeedbackNoteRow,
  ParticipantRow,
} from "@join-the-six/database";

import { displayNameFor } from "../inbox/conversation.view.js";

const QUESTION_LABELS: Record<string, string> = {
  event_score: "Βαθμολογία εκδήλωσης",
  liked: "Με ποιον/ποια συνδέθηκε",
  meet_again: "Με ποιον/ποια θα ήθελε να ξανασυναντηθεί",
  avoid: "Με ποιον/ποια θα ήθελε να αποφύγει",
};

const NOTE_TYPE_LABELS: Record<string, string> = {
  activity_interest: "Ενδιαφέρον δραστηριότητας",
  general: "Γενική σημείωση",
};

export function buildFeedbackCampaignSummaryPrompt(input: {
  readonly isPartial: boolean;
  readonly openConversationCount: number;
  readonly closedConversationCount: number;
  readonly answers: readonly FeedbackAnswerRow[];
  readonly notes: readonly FeedbackNoteRow[];
  readonly displayNames: ReadonlyMap<string, ParticipantRow>;
}): string {
  const sections: string[] = [
    "Είσαι αναλυτής ανατροφοδότησης μετά από εκδηλώσεις του Join The Six.",
    "Γράψε μια δομημένη αφήγηση στα ελληνικά σε markdown για τους operators.",
    "Μην εφευρίσκεις δεδομένα — χρησιμοποίησε μόνο ό,τι δίνεται παρακάτω.",
    "Δομή: σύντομη επισκόπηση, βαθμολογίες/τάσεις, θετικές συνδέσεις, αρνητικές/αποφυγές, σημειώσεις, αν χρειάζεται ενέργειες.",
    "",
    `Κατάσταση: ${input.isPartial ? "μερική (υπάρχουν ακόμη ανοιχτές συζητήσεις)" : "πλήρης (όλες οι συζητήσεις έκλεισαν)"}`,
    `Ανοιχτές συζητήσεις: ${input.openConversationCount}`,
    `Κλειστές συζητήσεις: ${input.closedConversationCount}`,
    "",
    "## Απαντήσεις",
    formatAnswers(input.answers, input.displayNames),
    "",
    "## Σημειώσεις",
    formatNotes(input.notes, input.displayNames),
  ];

  return sections.join("\n");
}

function formatAnswers(
  answers: readonly FeedbackAnswerRow[],
  displayNames: ReadonlyMap<string, ParticipantRow>,
): string {
  if (answers.length === 0) {
    return "Καμία καταγεγραμμένη απάντηση.";
  }

  return answers
    .map((answer) => {
      const respondent = nameFor(answer.respondentParticipantId, displayNames);
      const subject = answer.subjectParticipantId
        ? nameFor(answer.subjectParticipantId, displayNames)
        : null;
      const question =
        QUESTION_LABELS[answer.questionKey] ?? answer.questionKey;
      const value =
        answer.valueInt !== null && answer.valueInt !== undefined
          ? ` (${answer.valueInt}/5)`
          : "";
      const subjectPart = subject ? ` → ${subject}` : "";
      return `- ${respondent}: ${question}${subjectPart}${value}`;
    })
    .join("\n");
}

function formatNotes(
  notes: readonly FeedbackNoteRow[],
  displayNames: ReadonlyMap<string, ParticipantRow>,
): string {
  if (notes.length === 0) {
    return "Καμία καταγεγραμμένη σημείωση.";
  }

  return notes
    .map((note) => {
      const respondent = nameFor(note.respondentParticipantId, displayNames);
      const subject = note.subjectParticipantId
        ? nameFor(note.subjectParticipantId, displayNames)
        : null;
      const type = NOTE_TYPE_LABELS[note.noteType] ?? note.noteType;
      const subjectPart = subject ? ` (για ${subject})` : "";
      return `- ${respondent} [${type}]${subjectPart}: «${note.text}»`;
    })
    .join("\n");
}

function nameFor(
  participantId: string,
  displayNames: ReadonlyMap<string, ParticipantRow>,
): string {
  return displayNameFor(displayNames.get(participantId)) ?? participantId;
}
