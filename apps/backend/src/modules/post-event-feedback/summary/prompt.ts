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
    "Γράψε στα ελληνικά, σε markdown, για operator που έχει τριάντα δευτερόλεπτα.",
    "Μην εφευρίσκεις δεδομένα — χρησιμοποίησε μόνο ό,τι δίνεται παρακάτω.",
    `Αναλύεις campaign με ερωτηματολόγιο V${input.questionSetVersion}. Ενεργά πεδία: ${input.questionDefinitions.map((definition) => definition.key).join(", ")}.`,
    ...versionInstructions(input.questionSetVersion),
    "Μην κατατάσσεις ανθρώπους και μην παράγεις σκορ δημοτικότητας. Η απουσία directed απάντησης είναι άγνωστο, όχι αρνητική ψήφος.",
    "",
    ...shapeInstructions(input.isPartial),
    "",
    ...limitInstructions(),
    "",
    ...presentationInstructions(),
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

/**
 * The report is the same three sections every time, in the same order, under
 * the same titles. Standing structure is what makes a series of campaigns
 * comparable at a glance — the reader learns where to look once — and it is
 * also the cheapest cure for padding: an open brief invites a model to fill
 * every heading it can think of, whether or not the data earned one.
 *
 * The three answer the three questions an operator actually has after a dinner:
 * how did it go, what did people say, and what do we do differently next time.
 * A fourth is offered only when the data is incomplete or thin, because a
 * caveats section that appears unconditionally is a section that gets skipped.
 *
 * Emoji sit in the headings and nowhere else. One mark per section is a
 * landmark you can scan to; emoji scattered through the prose is decoration
 * that slows the same reader down.
 */
function shapeInstructions(isPartial: boolean): readonly string[] {
  return [
    "## Σχήμα",
    "Αυτές οι τρεις ενότητες, με αυτή τη σειρά και ακριβώς αυτούς τους τίτλους — και μόνο αυτές, εκτός από την τέταρτη που περιγράφεται στο τέλος. Καμία εισαγωγή πριν, κανένα κλείσιμο μετά, καμία δική σου επικεφαλίδα.",
    "### 📊 Η βραδιά σε νούμερα",
    "Ένα γράφημα με τις βαθμολογίες και έως δύο προτάσεις για το τι δείχνει: τι ξεχωρίζει προς τα πάνω ή προς τα κάτω, όχι απαρίθμηση όλων των μεγεθών.",
    "### 💬 Τι ξεχώρισε",
    "Έως τρία bullets. Το καθένα ένα μοτίβο που εμφανίστηκε σε παραπάνω από έναν άνθρωπο, με τη σύντομη παράθεση ή τον αριθμό που το στηρίζει. Ό,τι είπε ένας μόνο άνθρωπος μπαίνει μόνο αν είναι πράγματι αξιοσημείωτο, και δηλώνεται ως μία φωνή.",
    "### 🎯 Τι κάνουμε",
    "Έως τρία bullets, καθένα συγκεκριμένη ενέργεια για την επόμενη βραδιά: καθίσματα, follow-up σε δηλωμένο ενδιαφέρον, ποιος θέλει να ξαναδεί ποιον. Αν τα δεδομένα δεν στηρίζουν ενέργεια, μία γραμμή που το λέει — μην εφευρίσκεις ενέργειες για να γεμίσεις την ενότητα.",
    isPartial
      ? "Πρόσθεσε τελευταία ενότητα «### ⚠️ Τι λείπει» με μία γραμμή: τι δεν καλύπτεται ακόμη επειδή υπάρχουν ανοιχτές συζητήσεις."
      : "Πρόσθεσε τελευταία ενότητα «### ⚠️ Τι λείπει» μόνο αν κάποιο σήμα στηρίζεται σε ελάχιστες απαντήσεις. Μία γραμμή, όχι παράγραφος. Αλλιώς παράλειψέ την τελείως.",
  ];
}

/**
 * Length is a product decision, not a stylistic preference: this body is read
 * inside a collapsed accordion above the conversation list, so anything that
 * scrolls has already lost the reader it was written for. The word budget is
 * stated as a number because «σύντομα» is advice a model can always argue
 * itself out of.
 */
function limitInstructions(): readonly string[] {
  return [
    "## Όρια",
    "Όλη η αναφορά κάτω από 200 λέξεις. Κάθε bullet μία γραμμή, έως 20 λέξεις.",
    "Κάθε γεγονός λέγεται μία φορά. Αριθμός που φαίνεται στο γράφημα δεν ξαναγράφεται σε πρόταση, εκτός αν η πρόταση προσθέτει ερμηνεία που το γράφημα δεν δείχνει.",
    "Χωρίς εισαγωγικές φράσεις τύπου «Σε αυτή την αναφορά», χωρίς τελική σύνοψη, χωρίς επανάληψη της εκφώνησης ή του πλήθους συζητήσεων που ήδη ξέρει η οθόνη.",
    "Προτίμησε το ρήμα από την περίφραση και το συγκεκριμένο από το γενικό. Αν μια πρόταση δεν αλλάζει τι θα κάνει ο operator, σβήσ' την.",
    "Emoji μόνο στους τίτλους των ενοτήτων — πουθενά μέσα στο κείμενο.",
  ];
}

/**
 * What the admin accordion can actually draw. It renders the body through the
 * assistant's renderer, so the markdown the model already writes gains GitHub
 * tables and the fenced `chart` contract of `AssistantChart` — the same fence
 * the assistant system prompt offers, kept worded the same way on purpose.
 *
 * The no-ranking rule is repeated here rather than assumed: a bar chart whose
 * axis is participant names is a popularity ranking however carefully the
 * surrounding prose avoids being one, and the chart channel is exactly where
 * that rule is easiest to lose.
 */
function presentationInstructions(): readonly string[] {
  return [
    "## Μορφή",
    "Το σώμα αποδίδεται ως markdown: επικεφαλίδες, λίστες, έντονα, παραθέσεις και πίνακες GitHub. Σε αναφορά αυτού του μεγέθους ο πίνακας σπάνια χρειάζεται — τα bullets και το γράφημα τα λένε ήδη.",
    "Μπορείς επίσης να ενσωματώσεις γράφημα ως fenced block `chart` με ένα JSON αντικείμενο:",
    "```chart",
    '{"type":"bar","title":"Κατανομή συνολικής αξιολόγησης","unit":"απαντήσεις","data":[{"label":"5/5","value":3},{"label":"4/5","value":2},{"label":"3/5","value":1}]}',
    "```",
    'Πεδία: `data` υποχρεωτικό, με αριθμητικό `value` σε κάθε σημείο· `type` ένα από `bar` (κατανομές και συγκρίσεις) ή `line` (εξέλιξη σε σειρά)· `title`, `unit` και `max` προαιρετικά. Το `max` είναι η κορυφή της κλίμακας — δώσε `"max":5` όταν το μέγεθος είναι βαθμολογία 1–5, ώστε ένας μέσος όρος 4.2 να διαβάζεται ως 4.2 στα 5.',
    "Κάθε τιμή γραφήματος βγαίνει με μέτρημα ή μέσο όρο πάνω στα δεδομένα παρακάτω. Κανένα στρογγυλεμένο «περίπου», καμία τιμή που δεν προκύπτει από τις απαντήσεις.",
    "Ένα γράφημα στην πρώτη ενότητα, δεύτερο μόνο αν δείχνει κάτι που το πρώτο δεν δείχνει — κατανομή μιας βαθμολογίας ή σύγκριση των διαστάσεων μεταξύ τους. Ποτέ τρίτο.",
    "Μη φτιάχνεις γράφημα με ονόματα συμμετεχόντων στους άξονες: αυτό θα ήταν κατάταξη ανθρώπων.",
    "Με ελάχιστες απαντήσεις μην κάνεις γράφημα· δύο σημεία δεν είναι κατανομή.",
  ];
}

function versionInstructions(
  version: PostEventFeedbackQuestionSetVersion,
): readonly string[] {
  if (version === 1) {
    return [
      "Το liked είναι η απάντηση V1 για το ποιος έκανε ιδιαίτερα καλή εντύπωση. Κράτησέ το χωριστά από το meet_again, που είναι πρόθεση μελλοντικής επαφής· είναι συγγενή αλλά όχι ταυτόσημα σήματα.",
      "Το avoid στη V1 σημαίνει ότι ο respondent θα προτιμούσε να μην ξαναπετύχει το συγκεκριμένο άτομο. Μην το παρουσιάζεις ως καταγγελία, παράπτωμα, κίνδυνο ή αξιολόγηση χαρακτήρα.",
    ];
  }
  return [
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
