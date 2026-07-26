import {
  POST_EVENT_FEEDBACK_QUESTION_SET_V1,
  type PostEventFeedbackQuestionSetCopy,
} from "./post-event-feedback-question-set.js";
import {
  FEEDBACK_EXTRACTION_MAX_ANSWERS,
  FEEDBACK_EXTRACTION_MAX_NOTES,
  FEEDBACK_EXTRACTION_NOTE_MAX_LENGTH,
  FEEDBACK_EXTRACTION_REPLY_MAX_LENGTH,
  type FeedbackExtractionContext,
} from "./post-event-feedback-extraction.schemas.js";

export interface FeedbackExtractionPrompt {
  readonly system: string;
  readonly user: string;
}

export interface BuildFeedbackExtractionPromptInput {
  readonly context: FeedbackExtractionContext;
  readonly copy: PostEventFeedbackQuestionSetCopy;
}

/**
 * Greek-first extraction prompt.
 *
 * The conversation is Greek, so the instructions and the reply are Greek; the
 * structured field names stay English because they are the persisted contract.
 * Everything the model may reason about is in this string — the full
 * actor-labelled transcript, the campaign's question copy snapshot, the live
 * D16 candidate set and the results already accepted — because the model is
 * given no tools and no store access.
 *
 * The candidate block is the only source of participant identity. Ambiguity is
 * handled here rather than in validation: when two candidates share the same
 * written name, application code cannot tell a correct pick from a lucky guess,
 * so the prompt requires a clarifying question instead.
 */
export function buildFeedbackExtractionPrompt(
  input: BuildFeedbackExtractionPromptInput,
): FeedbackExtractionPrompt {
  return {
    system: buildSystemPrompt(),
    user: buildUserPrompt(input),
  };
}

function buildSystemPrompt(): string {
  const noteTypes = POST_EVENT_FEEDBACK_QUESTION_SET_V1.noteTypes
    .map((noteType) => noteType.key)
    .join(", ");
  return [
    "Είσαι ο βοηθός ανάλυσης του Join The Six για τα μηνύματα ανατροφοδότησης μετά από ένα δείπνο.",
    "Διαβάζεις μια συνομιλία στο WhatsApp και προτείνεις δομημένα αποτελέσματα. Δεν στέλνεις τίποτα, δεν αποθηκεύεις τίποτα και δεν αλλάζεις καμία ρύθμιση — η πρότασή σου ελέγχεται από τον κώδικα πριν χρησιμοποιηθεί.",
    "",
    "ΚΑΝΟΝΕΣ",
    "1. Μόνο τα μηνύματα με actor=participant είναι μαρτυρία. Τα μηνύματα bot και staff είναι μόνο πλαίσιο και δεν τεκμηριώνουν ποτέ απάντηση ή σημείωση.",
    "2. Εξάγεις αποτελέσματα ΜΟΝΟ από τα ids στη λίστα ΝΕΑ ΜΗΝΥΜΑΤΑ ΠΡΟΣ ΕΞΑΓΩΓΗ. Κάθε πρόταση αναφέρει στο sourceMessageIds τα ακριβή id αυτών των participant μηνυμάτων. Η παλιότερη συνομιλία είναι μόνο πλαίσιο.",
    "3. Υποκείμενο μπορεί να είναι ΜΟΝΟ κάποιο participantId από τη λίστα ΥΠΟΨΗΦΙΟΙ. Ποτέ δεν εφευρίσκεις id και ποτέ δεν βάζεις τον ίδιο τον συνομιλητή ως υποκείμενο.",
    "4. Ταίριαξε το όνομα όπως γράφτηκε, επιτρέποντας μόνο φυσιολογική ελληνική κλίση (π.χ. Νίκο→Νίκος). Μη θεωρείς μια λατινική μεταγραφή ίση με διαφορετικά γραμμένο ελληνικό όνομα. Αν το γραμμένο όνομα ταιριάζει σε ΠΕΡΙΣΣΟΤΕΡΟΥΣ ΑΠΟ ΕΝΑΝ υποψήφιο, ΜΗΝ μαντεύεις: μην προτείνεις directed answer, αλλά κράτησε τυχόν τεκμηριωμένη general note με subjectParticipantId κενό και ρώτησε στο reply ποιον εννοεί.",
    "5. Αν ένα όνομα δεν ταιριάζει σε κανέναν υποψήφιο, μην προτείνεις απάντηση. Πρότεινε σημείωση τύπου general με subjectParticipantId κενό και subjectMentionedName το όνομα όπως γράφτηκε.",
    `6. Επιτρεπτά note types: ${noteTypes}. Το κείμενο της σημείωσης είναι σύντομη περίληψη στα ελληνικά, το πολύ ${FEEDBACK_EXTRACTION_NOTE_MAX_LENGTH} χαρακτήρες, και μένει πιστό στα λόγια του συμμετέχοντα.`,
    "7. Μην προτείνεις ξανά αποτέλεσμα που υπάρχει ήδη στα ΚΑΤΑΓΕΓΡΑΜΜΕΝΑ ΑΠΟΤΕΛΕΣΜΑΤΑ, και μην ξανανοίγεις στόχο που έχει ήδη απαντηθεί.",
    "8. skippedGoals: βάλε εκεί τον στόχο που ο συμμετέχων αρνήθηκε ρητά να απαντήσει ή απάντησε ότι δεν έχει κάτι να πει (π.χ. «κανέναν», «όλοι καλοί ήταν»).",
    "9. Για κάθε νέο participant μήνυμα απάντησε πρώτα στον τρέχοντα asked στόχο και μετά πρόσθεσε τυχόν ordinary note. Δεν καταπίνεις answer ή note επειδή το περιεχόμενο είναι άβολο ή επειδή προτείνεις handoff.",
    "9β. Answer γράφεις ΜΟΝΟ για γνώμη που είναι του ίδιου του συμμετέχοντα. Αν το κείμενο αποδίδει ρητά τη γνώμη σε άλλον («ο άντρας μου λέει…», «η φίλη μου βρήκε…»), δεν γίνεται answer — γίνεται note που λέει καθαρά ποιανού είναι η γνώμη. Ένα WhatsApp μπορεί να το μοιράζονται δύο άνθρωποι· η συνομιλία ανήκει σε έναν, και μια ξένη γνώμη καταγεγραμμένη σαν δική του είναι λάθος για αληθινό πρόσωπο.",
    "10. handoff=true όταν ο participant ζητά ρητά να μιλήσει με άνθρωπο, ΚΑΙ όταν ζητά να σβηστούν ή να μην κρατηθούν όσα είπε (π.χ. «σβήστε αυτά που είπα», «δε θέλω να μείνουν πουθενά»). Το δεύτερο είναι αίτημα προς άνθρωπο, όχι σχόλιο για τη βραδιά: εσύ δεν σβήνεις τίποτα και δεν υπόσχεσαι ότι θα σβηστεί — κρατάς τα λόγια του ως σημείωση και το περνάς σε άνθρωπο. Η εφαρμογή ταξινομεί την προτεραιότητα staff σε ξεχωριστό βήμα· εσύ δεν την προβλέπεις εδώ.",
    `11. Το reply είναι ΕΝΑ σύντομο, φυσικό μήνυμα στα ελληνικά (έως ${FEEDBACK_EXTRACTION_REPLY_MAX_LENGTH} χαρακτήρες) που προχωρά στον επόμενο στόχο. Ταίριαξε διακριτικά τον τόνο: σε ακίνδυνη καφρίλα επιτρέπεται παιχνιδιάρικη αλλά ασφαλής ανακατεύθυνση, χωρίς να επαναλαμβάνεις τη χυδαία λέξη ή να ενθαρρύνεις αντικειμενοποίηση. Αν περιγράφεται ανεπιθύμητη ή επικίνδυνη συμπεριφορά, απάντησε ήρεμα και υποστηρικτικά. ΠΟΤΕ μην λες ότι κάποιος θα επικοινωνήσει, ότι «θα το φροντίσουμε» ή πότε θα γίνει ενέργεια· το μοντέλο δεν ελέγχει ανθρώπους. Μην αποκαλύπτεις τι είπαν άλλοι για κάποιον.`,
    `12. Το πολύ ${FEEDBACK_EXTRACTION_MAX_ANSWERS} απαντήσεις και ${FEEDBACK_EXTRACTION_MAX_NOTES} σημειώσεις ανά κλήση. Αν δεν υπάρχει τίποτα νέο, γύρνα κενές λίστες.`,
    "13. confidence: 0 έως 1, πόσο σίγουρος είσαι συνολικά για την πρόταση.",
  ].join("\n");
}

function buildUserPrompt(input: BuildFeedbackExtractionPromptInput): string {
  const { context, copy } = input;

  return [
    "ΕΡΩΤΗΣΕΙΣ ΚΑΜΠΑΝΙΑΣ",
    formatQuestions(copy),
    "",
    "ΣΤΟΧΟΙ",
    formatGoals(context),
    "",
    "ΥΠΟΨΗΦΙΟΙ (μόνο αυτοί επιτρέπονται ως υποκείμενα)",
    formatCandidates(context),
    "",
    "ΚΑΤΑΓΕΓΡΑΜΜΕΝΑ ΑΠΟΤΕΛΕΣΜΑΤΑ",
    formatAcceptedResults(context),
    "",
    "ΝΕΑ ΜΗΝΥΜΑΤΑ ΠΡΟΣ ΕΞΑΓΩΓΗ",
    context.newParticipantMessageIds.map((id) => `- ${id}`).join("\n"),
    "",
    "ΣΥΝΟΜΙΛΙΑ",
    formatTranscript(context),
  ].join("\n");
}

function formatQuestions(copy: PostEventFeedbackQuestionSetCopy): string {
  return POST_EVENT_FEEDBACK_QUESTION_SET_V1.answerQuestions
    .map((question) => {
      const shape =
        question.valueKind === "int"
          ? `ακέραιος ${question.intMin}-${question.intMax}, χωρίς υποκείμενο`
          : "ένα ή περισσότερα participantId από τους ΥΠΟΨΗΦΙΟΥΣ";
      return `- ${question.key} (${shape}): ${copy[question.key]}`;
    })
    .join("\n");
}

function formatGoals(context: FeedbackExtractionContext): string {
  return context.goals
    .map((goal) => `- ${goal.ordinal}. ${goal.key}: ${goal.status}`)
    .join("\n");
}

function formatCandidates(context: FeedbackExtractionContext): string {
  if (context.candidates.length === 0) {
    return "- (κανένας· μην προτείνεις απάντηση με υποκείμενο)";
  }
  return context.candidates
    .map(
      (candidate) => `- ${candidate.participantId} = ${candidate.displayName}`,
    )
    .join("\n");
}

function formatAcceptedResults(context: FeedbackExtractionContext): string {
  const answers = context.acceptedAnswers.map((answer) => {
    const value =
      answer.valueInt === null
        ? (answer.subjectParticipantId ?? "—")
        : String(answer.valueInt);
    return `- answer ${answer.questionKey}: ${value}`;
  });
  const notes = context.acceptedNotes.map(
    (note) =>
      `- note ${note.noteType}${
        note.subjectParticipantId ? ` (${note.subjectParticipantId})` : ""
      }: ${note.text}`,
  );
  const lines = [...answers, ...notes];
  return lines.length > 0 ? lines.join("\n") : "- (κανένα ακόμη)";
}

function formatTranscript(context: FeedbackExtractionContext): string {
  if (context.messages.length === 0) {
    return "- (κενή)";
  }
  return context.messages
    .map(
      (message) =>
        `[${message.seq}] at=${message.occurredAt} id=${message.id} actor=${message.actor}: ${message.text}`,
    )
    .join("\n");
}

/**
 * Rough token estimate for the assembled prompt.
 *
 * Input pressure is measured in tokens, not message count (ADR 0008): a
 * fifteen-message thread of long Greek paragraphs costs far more than fifty
 * one-word replies, and a message counter would report the opposite. Greek is
 * multi-byte and tokenizes worse than English, so the divisor is deliberately
 * pessimistic. This is an operational signal for deciding when summarisation
 * becomes necessary — the provider's reported usage is the billing truth.
 */
export const FEEDBACK_EXTRACTION_CHARS_PER_TOKEN = 2.5;

export function estimateFeedbackExtractionTokens(
  prompt: FeedbackExtractionPrompt,
): number {
  const characters = prompt.system.length + prompt.user.length;
  return Math.ceil(characters / FEEDBACK_EXTRACTION_CHARS_PER_TOKEN);
}
