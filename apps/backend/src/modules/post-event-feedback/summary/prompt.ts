import type {
  FeedbackAnswerRow,
  FeedbackNoteRow,
  ParticipantRow,
} from "@join-the-six/database";

import { displayNameFor } from "../inbox/conversation.view.js";
import type {
  PostEventFeedbackAnswerQuestionDefinition,
  PostEventFeedbackQuestionSetVersion,
} from "../question-set.js";

const QUESTION_LABELS: Readonly<
  Record<PostEventFeedbackQuestionSetVersion, Readonly<Record<string, string>>>
> = {
  1: {
    event_score: "Συνολική βαθμολογία βραδιάς",
    liked: "Άτομο που του/της έκανε ιδιαίτερα καλή εντύπωση",
    meet_again: "Θα ήθελε να ξαναβρεθεί μαζί του/της",
    avoid: "Θα προτιμούσε να μην τον/την ξαναπετύχει",
  },
  2: {
    event_score: "Συνολική αξιολόγηση βραδιάς",
    table_fit: "Καταλληλότητα παρέας και τραπεζιού",
    participation_ease: "Ευκολία συμμετοχής στη συζήτηση",
    conversation_balance: "Ισορροπία συμμετοχής στη συζήτηση",
    meet_again: "Θα χαιρόταν να ξαναβρεθεί μαζί του/της",
    avoid: "Προτιμά να μη βρεθούν ξανά στο ίδιο τραπέζι",
  },
};

const NOTE_TYPE_LABELS: Record<string, string> = {
  activity_interest: "Ενδιαφέρον δραστηριότητας",
  general: "Γενική σημείωση",
};

export function buildFeedbackCampaignSummaryPrompt(input: {
  readonly questionSetVersion: PostEventFeedbackQuestionSetVersion;
  readonly questionDefinitions: readonly PostEventFeedbackAnswerQuestionDefinition[];
  readonly isPartial: boolean;
  readonly openConversationCount: number;
  readonly closedConversationCount: number;
  readonly answers: readonly FeedbackAnswerRow[];
  readonly notes: readonly FeedbackNoteRow[];
  readonly displayNames: ReadonlyMap<string, ParticipantRow>;
}): string {
  const questionLabels = QUESTION_LABELS[input.questionSetVersion];
  const questionDefinitions = new Map<
    string,
    PostEventFeedbackAnswerQuestionDefinition
  >(
    input.questionDefinitions.map((definition) => [definition.key, definition]),
  );
  const sections: string[] = [
    "Είσαι αναλυτής ανατροφοδότησης μετά από εκδηλώσεις του Join The Six.",
    "Γράψε μια δομημένη αφήγηση στα ελληνικά σε markdown για τους operators.",
    "Μην εφευρίσκεις δεδομένα — χρησιμοποίησε μόνο ό,τι δίνεται παρακάτω.",
    `Αναλύεις campaign με ερωτηματολόγιο V${input.questionSetVersion}. Ενεργά πεδία: ${input.questionDefinitions.map((definition) => definition.key).join(", ")}.`,
    ...versionInstructions(input.questionSetVersion),
    "Μην κατατάσσεις ανθρώπους και μην παράγεις σκορ δημοτικότητας. Η απουσία directed απάντησης είναι άγνωστο, όχι αρνητική ψήφος.",
    "",
    `Κατάσταση: ${input.isPartial ? "μερική (υπάρχουν ακόμη ανοιχτές συζητήσεις)" : "πλήρης (όλες οι συζητήσεις έκλεισαν)"}`,
    `Ανοιχτές συζητήσεις: ${input.openConversationCount}`,
    `Κλειστές συζητήσεις: ${input.closedConversationCount}`,
    "",
    "## Απαντήσεις",
    formatAnswers(
      input.answers,
      input.displayNames,
      questionLabels,
      questionDefinitions,
    ),
    "",
    "## Σημειώσεις",
    formatNotes(input.notes, input.displayNames),
  ];

  return sections.join("\n");
}

function versionInstructions(
  version: PostEventFeedbackQuestionSetVersion,
): readonly string[] {
  if (version === 1) {
    return [
      "Δομή: σύντομη επισκόπηση, συνολική βαθμολογία, θετικές εντυπώσεις, πρόθεση να ξαναβρεθούν, προτιμήσεις αποφυγής, σημειώσεις, και ενέργειες μόνο όπου στηρίζονται στα δεδομένα.",
      "Το liked είναι η απάντηση V1 για το ποιος έκανε ιδιαίτερα καλή εντύπωση. Κράτησέ το χωριστά από το meet_again, που είναι πρόθεση μελλοντικής επαφής· είναι συγγενή αλλά όχι ταυτόσημα σήματα.",
      "Το avoid στη V1 σημαίνει ότι ο respondent θα προτιμούσε να μην ξαναπετύχει το συγκεκριμένο άτομο. Μην το παρουσιάζεις ως καταγγελία, παράπτωμα, κίνδυνο ή αξιολόγηση χαρακτήρα.",
    ];
  }
  return [
    "Δομή: σύντομη επισκόπηση, βαθμολογίες/τάσεις ανά διάσταση εμπειρίας, θετικές συνδέσεις, προτιμήσεις μη επανάληψης τραπεζιού, σημειώσεις, και ενέργειες μόνο όπου στηρίζονται στα δεδομένα.",
    "Κράτησε χωριστές τις τέσσερις βαθμολογίες: συνολική βραδιά, καταλληλότητα τραπεζιού, ευκολία συμμετοχής και ισορροπία συζήτησης. Όλες είναι σε κλίμακα 1–5.",
    "Το meet_again είναι πρόθεση μελλοντικής επαφής.",
    "Το avoid στη V2 σημαίνει μόνο προτίμηση να μη βρεθούν ξανά στο ίδιο τραπέζι. Μην το παρουσιάζεις ως καταγγελία, παράπτωμα, κίνδυνο ή αξιολόγηση χαρακτήρα.",
  ];
}

function formatAnswers(
  answers: readonly FeedbackAnswerRow[],
  displayNames: ReadonlyMap<string, ParticipantRow>,
  questionLabels: Readonly<Record<string, string>>,
  questionDefinitions: ReadonlyMap<
    string,
    PostEventFeedbackAnswerQuestionDefinition
  >,
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
      const question = questionLabels[answer.questionKey] ?? answer.questionKey;
      const definition = questionDefinitions.get(answer.questionKey);
      const value =
        answer.valueInt !== null && answer.valueInt !== undefined
          ? definition?.valueKind === "int" && definition.intMax !== undefined
            ? ` (${answer.valueInt}/${definition.intMax})`
            : ` (${answer.valueInt})`
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
