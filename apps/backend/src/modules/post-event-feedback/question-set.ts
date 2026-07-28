import {
  FEEDBACK_ANSWER_QUESTION_KEYS,
  FEEDBACK_NOTE_TYPES,
  type FeedbackAnswerQuestionKey,
  type FeedbackNoteType,
} from "@join-the-six/database";

import { FEEDBACK_CONVERSATION_MESSAGE_MAX_STORED_TEXT_LENGTH } from "./post-event-feedback-conversation.document.js";

export { FEEDBACK_ANSWER_QUESTION_KEYS, FEEDBACK_NOTE_TYPES };

export const POST_EVENT_FEEDBACK_QUESTION_SET_VERSION = 1 as const;

export const POST_EVENT_FEEDBACK_COPY_KEYS = [
  "intro",
  "event_score",
  "liked",
  "meet_again",
  "avoid",
  "closing",
  "declined",
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
  // The ending for somebody who declined every question. Πάνος Μούλαρος wrote
  // «δε λεω τιποτα» three times and received nothing at all after the intro —
  // the thank-you is correctly withheld from an empty ladder, and there was
  // nothing behind it. Silence obeys him, but it also leaves him unsure anybody
  // read it, and a closed conversation cannot answer whatever he writes next.
  //
  // No thanks, because there is nothing to thank him for. No question, because
  // he has answered that four times. No apology, because he did nothing wrong.
  // The promise is one we actually keep: the conversation closes, and the
  // reminder sweep does not wake a closed one.
  declined: "Κανένα πρόβλημα, δεν θα σε ξαναρωτήσουμε. Καλή συνέχεια! 🙂",
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

/**
 * The campaign's launch copy snapshot owns the wording, so a later copy edit
 * never rewrites a live questionnaire. The versioned constant is the fallback
 * when the snapshot is missing or malformed.
 */
export function resolveCampaignCopy(
  questions: Record<string, unknown> | undefined,
): PostEventFeedbackQuestionSetCopy {
  const snapshot = (questions as { copy?: Record<string, unknown> } | undefined)
    ?.copy;
  const resolved: PostEventFeedbackQuestionSetCopy = {
    ...POST_EVENT_FEEDBACK_QUESTION_SET_V1.copy,
  };

  if (!snapshot) {
    return resolved;
  }
  for (const key of Object.keys(resolved) as (keyof typeof resolved)[]) {
    const value = snapshot[key];
    if (typeof value === "string" && value.trim().length > 0) {
      resolved[key] = value.trim();
    }
  }
  return resolved;
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

export function createFeedbackStopAckDedupeKey(conversationId: string): string {
  return `feedback-stop-ack-${conversationId}`;
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

/**
 * Whether this question's answer is a number.
 *
 * `event_score` is; `liked`, `meet_again` and `avoid` answer with a person and
 * leave `value_int` null. The distinction decides what an operator correction
 * can even mean: there is no number to fix on a question whose answer is who.
 */
export function isScoredPostEventFeedbackQuestion(value: string): boolean {
  return POST_EVENT_FEEDBACK_QUESTION_SET_V1.answerQuestions.some(
    (question) => question.key === value && question.valueKind === "int",
  );
}

/**
 * Whether this question's answer agrees with the other directed questions'.
 *
 * `liked` and `meet_again` are one decision said twice: «η Μαρία μου άρεσε,
 * μαζί της θα ξαναέβγαινα» answers both, about one person, in one breath — so
 * these two are exactly where a model that has already written the person down
 * once reports the other goal as unanswered. `avoid` is the opposite decision
 * (`contradictedQuestionKeys` in the extractor is that half) and «κανέναν να
 * αποφύγω» is the commonest honest answer in the questionnaire, so a decline of
 * it is ordinary and must stay cheap. `event_score` is not directed at anybody.
 */
export function isAgreeingDirectedPostEventFeedbackQuestion(
  value: string,
): boolean {
  return value === "liked" || value === "meet_again";
}

export function isPostEventFeedbackNoteType(
  value: string,
): value is FeedbackNoteType {
  return (FEEDBACK_NOTE_TYPES as readonly string[]).includes(value);
}

/** Replay guard for `feedback_notes`, which has no natural unique key. */
export function noteSignature(
  noteType: string,
  text: string,
  subjectParticipantId: string | null,
): string {
  return `${noteType}::${subjectParticipantId ?? ""}::${text
    .trim()
    .replaceAll(/\s+/gu, " ")
    .toLowerCase()}`;
}

/**
 * Fits a body to the transcript, which is bounded, without pretending the rest
 * never existed.
 *
 * The bound is the transcript's *storage* limit, not the 4 096 characters we
 * are allowed to send. Those were once the same number and the cut happened at
 * the webhook edge, so a long message lost its tail before anything durable was
 * written and nobody was told — and the tail is where the thing somebody worked
 * up to saying actually lives. At 64 000 characters this now fires only for a
 * genuinely absurd payload, and still says so.
 */
export function fitToTranscript(text: string): {
  readonly text: string;
  readonly truncated: boolean;
} {
  if (text.length <= FEEDBACK_CONVERSATION_MESSAGE_MAX_STORED_TEXT_LENGTH) {
    return { text, truncated: false };
  }
  return {
    text: text.slice(0, FEEDBACK_CONVERSATION_MESSAGE_MAX_STORED_TEXT_LENGTH),
    truncated: true,
  };
}
