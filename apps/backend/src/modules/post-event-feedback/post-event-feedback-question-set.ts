export const POST_EVENT_FEEDBACK_QUESTION_SET_VERSION = 1 as const;

export const POST_EVENT_FEEDBACK_ANSWER_QUESTION_KEYS = [
  "event_score",
  "liked",
  "meet_again",
  "avoid",
] as const;

export const POST_EVENT_FEEDBACK_NOTE_TYPES = [
  "activity_interest",
  "general",
] as const;

export const POST_EVENT_FEEDBACK_COPY_KEYS = [
  "intro",
  "event_score",
  "liked",
  "meet_again",
  "avoid",
  "closing",
  "stop_ack",
  "reminder",
] as const;

export type PostEventFeedbackQuestionSetVersion =
  typeof POST_EVENT_FEEDBACK_QUESTION_SET_VERSION;

export type PostEventFeedbackAnswerQuestionKey =
  (typeof POST_EVENT_FEEDBACK_ANSWER_QUESTION_KEYS)[number];

export type PostEventFeedbackNoteType =
  (typeof POST_EVENT_FEEDBACK_NOTE_TYPES)[number];

export type PostEventFeedbackCopyKey =
  (typeof POST_EVENT_FEEDBACK_COPY_KEYS)[number];

export type PostEventFeedbackAnswerQuestionDefinition = {
  key: PostEventFeedbackAnswerQuestionKey;
  valueKind: "int" | "candidate_ids";
  subjectless: boolean;
  skippable: true;
  intMin?: number;
  intMax?: number;
};

export type PostEventFeedbackNoteTypeDefinition = {
  key: PostEventFeedbackNoteType;
  maxLength: number;
};

export type PostEventFeedbackQuestionSetCopy = Record<
  PostEventFeedbackCopyKey,
  string
>;

export type PostEventFeedbackQuestionSetV1 = {
  version: PostEventFeedbackQuestionSetVersion;
  answerQuestions: readonly PostEventFeedbackAnswerQuestionDefinition[];
  noteTypes: readonly PostEventFeedbackNoteTypeDefinition[];
  copy: PostEventFeedbackQuestionSetCopy;
};

const POST_EVENT_FEEDBACK_QUESTION_SET_V1_COPY = {
  intro:
    "Γεια σου {name}! Εδώ η ομάδα του Join The Six 🙂 Ελπίζουμε να πέρασες όμορφα. Θα ήθελες να μας πεις 2-3 πράγματα για τη βραδιά; Παίρνει λιγότερο από 2 λεπτά. (Αν δεν θες μηνύματα, γράψε ΣΤΟΠ.)",
  event_score: "Πώς σου φάνηκε συνολικά η βραδιά, από το 1 ως το 5;",
  liked:
    "Υπήρχε κάποιος ή κάποια από την παρέα που σου έκανε ιδιαίτερα καλή εντύπωση;",
  meet_again:
    "Με ποιους από την παρέα θα ήθελες να ξαναβρεθείς σε επόμενο τραπέζι;",
  avoid:
    "Υπάρχει κάποιος ή κάποια που θα προτιμούσες να μην πετύχεις ξανά; Μένει αυστηρά μεταξύ μας.",
  closing:
    "Τέλεια, ευχαριστούμε πολύ! Ό,τι άλλο θες να μας πεις, είμαστε εδώ. 🙌",
  stop_ack: "Έγινε, δεν θα ξαναλάβεις μηνύματα από εμάς σε αυτό το νούμερο.",
  reminder:
    "Καλημέρα {name}! Αν έχεις 2 λεπτά, θα χαρούμε πολύ να μάθουμε πώς σου φάνηκε η βραδιά 🙂 (Γράψε ΣΤΟΠ αν δεν θες μηνύματα.)",
} as const satisfies PostEventFeedbackQuestionSetCopy;

export const POST_EVENT_FEEDBACK_QUESTION_SET_V1 = {
  version: POST_EVENT_FEEDBACK_QUESTION_SET_VERSION,
  answerQuestions: [
    {
      key: "event_score",
      valueKind: "int",
      subjectless: true,
      skippable: true,
      intMin: 1,
      intMax: 5,
    },
    {
      key: "liked",
      valueKind: "candidate_ids",
      subjectless: false,
      skippable: true,
    },
    {
      key: "meet_again",
      valueKind: "candidate_ids",
      subjectless: false,
      skippable: true,
    },
    {
      key: "avoid",
      valueKind: "candidate_ids",
      subjectless: false,
      skippable: true,
    },
  ],
  noteTypes: [
    { key: "activity_interest", maxLength: 500 },
    { key: "general", maxLength: 500 },
  ],
  copy: POST_EVENT_FEEDBACK_QUESTION_SET_V1_COPY,
} as const satisfies PostEventFeedbackQuestionSetV1;

export type PostEventFeedbackQuestionLaunchSnapshot = {
  questionSetVersion: PostEventFeedbackQuestionSetVersion;
  copy: PostEventFeedbackQuestionSetCopy;
};

export function buildPostEventFeedbackQuestionLaunchSnapshot(): PostEventFeedbackQuestionLaunchSnapshot {
  return {
    questionSetVersion: POST_EVENT_FEEDBACK_QUESTION_SET_V1.version,
    copy: { ...POST_EVENT_FEEDBACK_QUESTION_SET_V1.copy },
  };
}

export function isPostEventFeedbackAnswerQuestionKey(
  value: string,
): value is PostEventFeedbackAnswerQuestionKey {
  return (
    POST_EVENT_FEEDBACK_ANSWER_QUESTION_KEYS as readonly string[]
  ).includes(value);
}

export function isPostEventFeedbackNoteType(
  value: string,
): value is PostEventFeedbackNoteType {
  return (POST_EVENT_FEEDBACK_NOTE_TYPES as readonly string[]).includes(value);
}
