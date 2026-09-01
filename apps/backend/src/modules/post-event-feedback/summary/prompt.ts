import type {
  FeedbackAnswerRow,
  FeedbackNoteRow,
  ParticipantRow,
} from "@slopform/database";

import type { PostEventFeedbackAttentionReason } from "../attention.js";
import { displayNameFor } from "../inbox/conversation.view.js";
import type {
  PostEventFeedbackAnswerQuestionDefinition,
  PostEventFeedbackQuestionSetVersion,
} from "../question-set.js";
import type { FeedbackCampaignSummaryMetrics } from "./summary-metrics.js";

export type FeedbackSummaryAttentionEvidence = {
  readonly conversationId: string;
  readonly respondentParticipantId: string;
  readonly kind: PostEventFeedbackAttentionReason;
  readonly messageExcerpt: string | null;
};

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

const ATTENTION_KIND_LABELS: Readonly<
  Record<PostEventFeedbackAttentionReason, string>
> = {
  safety: "θέμα ασφαλείας",
  respondent_conduct: "συμπεριφορά του/της συνομιλητή/τριας",
  handoff: "αίτηση ανθρώπινης βοήθειας",
  unattributed_note: "σημείωση χωρίς ταυτοποίηση",
  answer_revision: "αναθεώρηση απάντησης",
  hostile_to_bot: "εχθρική στάση προς το bot",
  unfinished_questionnaire: "ημιτελές ερωτηματολόγιο",
  extraction_failed: "αποτυχία εξαγωγής",
  unreadable_message: "μη αναγνώσιμο μήνυμα",
  transcript_mismatch: "ασυμφωνία transcript",
  transcript_full: "γεμάτο transcript",
  undelivered_message: "μη παραδοθέν μήνυμα",
  post_closure_message: "μήνυμα μετά το κλείσιμο",
  stopped_without_answers: "STOP χωρίς απαντήσεις",
  unanswered_data_question: "αναπάντητο ερώτημα δεδομένων",
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
  readonly metrics: FeedbackCampaignSummaryMetrics;
  readonly attention: readonly FeedbackSummaryAttentionEvidence[];
}): string {
  const questionLabels = QUESTION_LABELS[input.questionSetVersion];
  const questionDefinitions = new Map<
    string,
    PostEventFeedbackAnswerQuestionDefinition
  >(
    input.questionDefinitions.map((definition) => [definition.key, definition]),
  );
  const sections: string[] = [
    "Είσαι ο συνάδελφος που διαβάζει το feedback μετά τη βραδιά και το λέει στον operator σε τριάντα δευτερόλεπτα.",
    "Γράψε στα ελληνικά — καθημερινά, ξερά, με χιούμορ όταν το κερδίζουν τα δεδομένα. Όχι εταιρικό memo, όχι δημοσιογραφικό ρεπορτάζ.",
    "Μην εφευρίσκεις δεδομένα — χρησιμοποίησε μόνο ό,τι δίνεται παρακάτω.",
    `Αναλύεις campaign με ερωτηματολόγιο V${input.questionSetVersion}. Ενεργά πεδία: ${input.questionDefinitions.map((definition) => definition.key).join(", ")}.`,
    ...versionInstructions(input.questionSetVersion),
    "Μην κατατάσσεις ανθρώπους και μην παράγεις σκορ δημοτικότητας. Η απουσία directed απάντησης είναι άγνωστο, όχι αρνητική ψήφος.",
    "",
    ...voiceInstructions(),
    "",
    ...shapeInstructions(input.isPartial),
    "",
    ...limitInstructions(),
    "",
    `Κατάσταση: ${input.isPartial ? "μερική (υπάρχουν ακόμη ανοιχτές συζητήσεις)" : "πλήρης (όλες οι συζητήσεις έκλεισαν)"}`,
    `Ανοιχτές συζητήσεις: ${input.openConversationCount}`,
    `Κλειστές συζητήσεις: ${input.closedConversationCount}`,
    "",
    "## Νούμερα (ήδη μετρημένα — μην τα ξαναϋπολογίσεις και μην τα επαναλάβεις ως λίστα)",
    formatMetrics(input.metrics),
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
    "",
    "## Unresolved attention / flagged evidence",
    formatAttention(input.attention, input.displayNames),
  ];

  return sections.join("\n");
}

/**
 * Voice is a product decision: the accordion is read by tired operators after
 * a dinner, not filed next to a risk report. Everyday Greek and a dry jab beat
 * euphemism — especially when the evidence already named the harm.
 */
function voiceInstructions(): readonly string[] {
  return [
    "## Φωνή",
    "Στα `wentWell`, `wentWrong`, `curiosities` και `actions`: μίλα σαν έξυπνος συνάδελφος στο μπαρ μετά τη βραδιά — καθημερινά ελληνικά, λίγο αθυρόστομα όταν χρειάζεται, ποτέ ψεύτικα «επαγγελματικά».",
    "Στο `gossip` μόνο: φωνή stand-up που καλύπτει τις μαλακίτσες της βραδιάς — observational, ξερό χιούμορ, ζουμί στα ονόματα και στη χημεία τραπεζιού όταν το evidence το δίνει. Κουτσομπόλικο, χωρίς εταιρικό memo, χωρίς να εφευρίσκεις punchlines όπου δεν υπάρχουν.",
    "Αν τα δεδομένα είναι γελοία ή εξωφρενικά, ένα ξερό αστείο επιτρέπεται — ιδίως όταν το ίδιο το όνομα ή η φράση ήδη κουβαλάει το αστείο.",
    "Όταν το evidence δείχνει ρατσισμό, εξύβριση ή abuse προς άλλον καλεσμένο (matching hold, respondent_conduct, abuse στις σημειώσεις/attention), πες το ξεκάθαρα στο `wentWrong`: είναι ρατσιστής/ρατσίστρια, όχι «ευαίσθητο θέμα» και όχι «προτίμηση τραπεζιού». Ποτέ τέτοιο υλικό στο `gossip`.",
    "Ένα σκέτο avoid χωρίς τέτοιο evidence παραμένει προτίμηση no-rematch — μην το βαφτίζεις παράπτωμα.",
  ];
}

/**
 * The numbers strip is drawn by the product from counted rows. The model only
 * fills the narrative lists the accordion renders: well/wrong, curiosities,
 * optional gossip, and next actions.
 */
function shapeInstructions(isPartial: boolean): readonly string[] {
  return [
    "## Σχήμα",
    "Συμπλήρωσε μόνο τα πεδία του structured output. Καμία εισαγωγή, κανένα markdown, κανένα γράφημα — τα νούμερα τα σχεδιάζει η οθόνη από τα μετρημένα μεγέθη παρακάτω.",
    "Hard ceiling ανά πεδίο (όχι κοινό pool): `gossip` έως 10, `wentWrong` έως 10, `wentWell` έως 5, `curiosities` έως 5, `actions` έως 5. Μην γεμίζεις μέχρι το ταβάνι με επανάληψη.",
    "`gossip` (Κουτσομπολιό) — πρωταγωνιστής: social tea για τις μαλακίτσες της βραδιάς. Ποιος άρεσε σε ποιον, χημεία τραπεζιού, πιπεράτες αλλά ακίνδυνες παραθέσεις, ποιος «έκλεψε» το βράδυ. Μάζεψε κάθε διακριτό juicy· μην σταματάς στις 3 γραμμές αν η βραδιά είχε tea. Ποτέ ρατσισμό, abuse ή conduct flags εδώ· αυτά μένουν στο wentWrong. Άδειο μόνο όταν πραγματικά δεν υπάρχει tea.",
    "`wentWrong`: μάζεψε διακριτές καταστάσεις που πήγαν στραβά (χαμηλές βαθμολογίες, παράπονα, flagged σημειώσεις, unresolved attention) — κάθε στοιχείο `{ text, weight }` με `weight` `low`|`medium`|`high`. Εδώ η πληρότητα μετράει περισσότερο από τη συντομία. `high` μόνο για ρατσισμό, abuse ή αιχμηρό multi-voice harm· `medium` για συνηθισμένα παράπονα· `low` για ήπια / single-voice. Όπου το evidence δείχνει ρατσισμό ή abuse, ονόμασέ το — μην το μαλακώνεις. Σκέτο avoid χωρίς τέτοιο σήμα μένει no-rematch preference σε `low` ή `medium`.",
    "`wentWell`: σύντομα ό,τι πήγε καλά (υψηλές βαθμολογίες, έπαινος, meet_again) — κάθε στοιχείο `{ text, weight }` με `weight` `low`|`medium`|`high`. `high` μόνο για ξεκάθαρα standout wins· προτίμησε `medium`. Χωρίς χρωματιστό padding· το ζουμί πάει στο gossip.",
    "Στα `wentWell`/`wentWrong`: μην βαφτίζεις κάθε γραμμή `high` — τα περισσότερα είναι `medium`· το `high` είναι η εξαίρεση που η οθόνη βάφει έντονα.",
    "`curiosities` (Αξιοπερίεργα): λίγα παράξενα μοτίβα που δεν είναι ήδη wentWell/wentWrong/gossip. Άδειο όταν τίποτα δεν αξίζει γραμμή.",
    "`actions`: λίγες συγκεκριμένες ενέργειες για την επόμενη βραδιά. Αν τα δεδομένα δεν στηρίζουν ενέργεια, άφησε τη λίστα άδεια — μην εφευρίσκεις δουλειά.",
    isPartial
      ? "`missing`: μία γραμμή για το τι δεν καλύπτεται ακόμη επειδή υπάρχουν ανοιχτές συζητήσεις."
      : "`missing`: μία γραμμή μόνο αν κάποιο σήμα στηρίζεται σε ελάχιστες απαντήσεις· αλλιώς null.",
  ];
}

/**
 * Length stays a product constraint — the accordion is still above the inbox —
 * but hard per-bullet word caps made the model chop Greek mid-thought. Soft
 * guidance keeps the lists scannable without inviting padding.
 */
function limitInstructions(): readonly string[] {
  return [
    "## Όρια",
    "Έξω από το `gossip`: κράτα τις λίστες σφιχτές χωρίς padding — κάθε στοιχείο περίπου μία γραμμή. Στο `gossip` μία γραμμή αρκεί συνήθως, αλλά επιτρέπεται λίγο περισσότερο χρώμα όταν η παράθεση το αξίζει.",
    "Μην κόβεις juicy gossip μόνο για να χωρέσει σε αριθμό· μην γεμίζεις `curiosities`/`actions`/`wentWell` επειδή υπάρχει χώρος.",
    "Κάθε γεγονός λέγεται μία φορά. Αριθμός που φαίνεται ήδη στα μετρημένα νούμερα δεν ξαναγράφεται, εκτός αν η πρόταση προσθέτει ερμηνεία.",
    "Χωρίς εισαγωγικές φράσεις τύπου «Σε αυτή την αναφορά», χωρίς τελική σύνοψη, χωρίς επανάληψη του πλήθους συζητήσεων που ήδη ξέρει η οθόνη.",
    "Προτίμησε το ρήμα από την περίφραση και το συγκεκριμένο από το γενικό. Εκτός gossip: αν μια πρόταση δεν αλλάζει τι θα κάνει ο operator, σβήσ' την.",
    "Χωρίς emoji.",
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
    "Κράτα χωριστές τις τέσσερις βαθμολογίες: συνολική βραδιά, καταλληλότητα τραπεζιού, ευκολία συμμετοχής και ισορροπία συζήτησης. Όλες είναι σε κλίμακα 1–5.",
    "Το meet_again είναι πρόθεση μελλοντικής επαφής.",
    "Το avoid στη V2 σημαίνει μόνο προτίμηση να μη βρεθούν ξανά στο ίδιο τραπέζι. Μην το παρουσιάζεις ως καταγγελία, παράπτωμα, κίνδυνο ή αξιολόγηση χαρακτήρα.",
  ];
}

function formatMetrics(metrics: FeedbackCampaignSummaryMetrics): string {
  const lines: string[] = [];
  for (const score of metrics.scores) {
    if (score.answerCount === 0 || score.average === null) {
      lines.push(`- ${score.label}: καμία απάντηση`);
      continue;
    }
    const distribution = score.distribution
      .filter((entry) => entry.count > 0)
      .map((entry) => `${entry.value}/${score.max}: ${entry.count}`)
      .join(", ");
    lines.push(
      `- ${score.label}: μέσος ${score.average}/${score.max} από ${score.answerCount} απαντήσεις (${distribution})`,
    );
  }
  for (const directed of metrics.directed) {
    lines.push(
      `- ${directed.label}: ${directed.edgeCount} δηλώσεις από ${directed.respondentCount} ανθρώπους`,
    );
  }
  return lines.length > 0 ? lines.join("\n") : "Κανένα μετρήσιμο μέγεθος.";
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
      const hold = answer.matchingHold ? " [matching hold]" : "";
      return `- ${respondent}: ${question}${subjectPart}${value}${hold}`;
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
      const flagged =
        note.extractionMeta["flaggedForReview"] === true
          ? " [flagged for review]"
          : "";
      return `- ${respondent} [${type}]${subjectPart}${flagged}: «${note.text}»`;
    })
    .join("\n");
}

function formatAttention(
  attention: readonly FeedbackSummaryAttentionEvidence[],
  displayNames: ReadonlyMap<string, ParticipantRow>,
): string {
  if (attention.length === 0) {
    return "Καμία ανοιχτή attention ένδειξη.";
  }

  return attention
    .map((item) => {
      const respondent = nameFor(item.respondentParticipantId, displayNames);
      const kind =
        ATTENTION_KIND_LABELS[item.kind] ?? item.kind.replaceAll("_", " ");
      const excerpt = item.messageExcerpt ? `: «${item.messageExcerpt}»` : "";
      return `- ${respondent} — ${kind}${excerpt}`;
    })
    .join("\n");
}

function nameFor(
  participantId: string,
  displayNames: ReadonlyMap<string, ParticipantRow>,
): string {
  return displayNameFor(displayNames.get(participantId)) ?? participantId;
}
