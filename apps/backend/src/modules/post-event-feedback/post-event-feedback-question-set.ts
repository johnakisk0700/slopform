import {
  FEEDBACK_ANSWER_QUESTION_KEYS,
  FEEDBACK_NOTE_TYPES,
  type FeedbackAnswerQuestionKey,
  type FeedbackNoteType,
} from "@join-the-six/database";

export { FEEDBACK_ANSWER_QUESTION_KEYS, FEEDBACK_NOTE_TYPES };

export const POST_EVENT_FEEDBACK_QUESTION_SET_VERSION = 1 as const;

export const POST_EVENT_FEEDBACK_COPY_KEYS = [
  "intro",
  "event_score",
  "liked",
  "meet_again",
  "avoid",
  "closing",
  "stop_ack",
  "reminder",
  "reminder_followup",
  "cannot_read_media",
] as const;

export type PostEventFeedbackQuestionSetVersion =
  typeof POST_EVENT_FEEDBACK_QUESTION_SET_VERSION;

export type PostEventFeedbackCopyKey =
  (typeof POST_EVENT_FEEDBACK_COPY_KEYS)[number];

export type PostEventFeedbackAnswerQuestionDefinition = {
  key: FeedbackAnswerQuestionKey;
  valueKind: "int" | "candidate_ids";
  subjectless: boolean;
  skippable: true;
  intMin?: number;
  intMax?: number;
};

export type PostEventFeedbackNoteTypeDefinition = {
  key: FeedbackNoteType;
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
  // For somebody who already started. The generic reminder asks them to tell
  // us about the evening, which reads as "we lost what you sent" to a person
  // who answered two questions yesterday — so restate the open one instead and
  // let them answer it directly.
  reminder_followup:
    "Γεια σου {name}! Είχαμε μείνει εδώ 🙂 {question} (Γράψε ΣΤΟΠ αν δεν θες μηνύματα.)",
  // Somebody answering out loud from the car is not a non-responder, but we
  // cannot read a voice note yet. Silence let them go on recording answers into
  // a void and land in the campaign list as somebody who never replied.
  cannot_read_media:
    "Συγγνώμη, δεν μπορούμε ακόμα να ακούσουμε φωνητικά ή να δούμε αρχεία εδώ 🙈 Αν μπορείς, γράψε μας το με λίγες λέξεις!",
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

/** Substitutes `{name}` in intro/reminder copy with a display name. */
export function renderPostEventFeedbackCopy(
  template: string,
  name: string,
): string {
  const trimmed = name.trim();
  return template.replaceAll("{name}", trimmed.length > 0 ? trimmed : "φίλε");
}

export function createFeedbackIntroDedupeKey(conversationId: string): string {
  return `feedback-intro-${conversationId}`;
}

/**
 * One "we cannot read that" notice per conversation, not per voice note.
 *
 * Somebody who answers out loud usually sends several in a row; repeating the
 * apology for each one is its own kind of rudeness, and the `dedupe_key` is
 * what makes "once" true even across a burst that materializes in parallel.
 */
export function createFeedbackMediaNoticeDedupeKey(
  conversationId: string,
): string {
  return `feedback-media-notice-${conversationId}`;
}

/**
 * One durable key per rung of the nudge ladder.
 *
 * The ordinal is what makes a second reminder possible at all: a single
 * per-conversation key meant the outbox absorbed every nudge after the first as
 * a duplicate, so the ladder could not have more than one rung no matter what
 * the sweep decided. It still guarantees the thing the key is for — a retried
 * or concurrent sweep cannot send rung 2 twice.
 */
export function createFeedbackReminderDedupeKey(
  conversationId: string,
  ordinal: number,
): string {
  return `feedback-reminder-${conversationId}-${ordinal}`;
}

export function isPostEventFeedbackAnswerQuestionKey(
  value: string,
): value is FeedbackAnswerQuestionKey {
  return (FEEDBACK_ANSWER_QUESTION_KEYS as readonly string[]).includes(value);
}

export function isPostEventFeedbackNoteType(
  value: string,
): value is FeedbackNoteType {
  return (FEEDBACK_NOTE_TYPES as readonly string[]).includes(value);
}
