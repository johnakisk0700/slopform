import {
  FEEDBACK_ANSWER_QUESTION_KEYS,
  FEEDBACK_NOTE_TYPES,
  type FeedbackAnswerQuestionKey,
  type FeedbackNoteType,
} from "@slopform/database";

import { FEEDBACK_CONVERSATION_MESSAGE_MAX_STORED_TEXT_LENGTH } from "./post-event-feedback-conversation.document.js";

export { FEEDBACK_ANSWER_QUESTION_KEYS, FEEDBACK_NOTE_TYPES };

export const POST_EVENT_FEEDBACK_QUESTION_SET_VERSIONS = [1, 2] as const;

export type PostEventFeedbackQuestionSetVersion =
  (typeof POST_EVENT_FEEDBACK_QUESTION_SET_VERSIONS)[number];

/** New campaigns launch on this version. Persisted campaigns keep their own. */
export const CURRENT_POST_EVENT_FEEDBACK_QUESTION_SET_VERSION = 2 as const;

/** @deprecated Prefer the explicit `CURRENT_...` name at new call sites. */
export const POST_EVENT_FEEDBACK_QUESTION_SET_VERSION =
  CURRENT_POST_EVENT_FEEDBACK_QUESTION_SET_VERSION;

export const POST_EVENT_FEEDBACK_COPY_KEYS = [
  "intro",
  "event_score",
  "table_fit",
  "participation_ease",
  "conversation_balance",
  "liked",
  "meet_again",
  "avoid",
  "event_score_reask",
  "table_fit_reask",
  "participation_ease_reask",
  "conversation_balance_reask",
  "liked_reask",
  "meet_again_reask",
  "avoid_reask",
  "closing",
  "closing_after_safety",
  "declined",
  "stop_ack",
  "reminder",
  "reminder_followup",
  "cannot_read_media",
] as const;

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

export type PostEventFeedbackQuestionSet = {
  version: PostEventFeedbackQuestionSetVersion;
  answerQuestions: readonly PostEventFeedbackAnswerQuestionDefinition[];
  noteTypes: readonly PostEventFeedbackNoteTypeDefinition[];
  copy: PostEventFeedbackQuestionSetCopy;
};

export type PostEventFeedbackQuestionSetV1 = PostEventFeedbackQuestionSet & {
  version: 1;
};

export type PostEventFeedbackQuestionSetV2 = PostEventFeedbackQuestionSet & {
  version: 2;
};

const POST_EVENT_FEEDBACK_QUESTION_SET_V1_COPY = {
  intro:
    "Γεια σου {name}! Εδώ η ομάδα του Join The Six 🙂 Ελπίζουμε να πέρασες όμορφα. Θα ήθελες να μας πεις 2-3 πράγματα για τη βραδιά; Παίρνει λιγότερο από 2 λεπτά. (Αν δεν θες μηνύματα, γράψε ΣΤΟΠ.)",
  event_score: "Πώς σου φάνηκε συνολικά η βραδιά, από το 1 ως το 5;",
  // V2-only keys stay present so a sparse snapshot still types as a full copy.
  table_fit:
    "Πόσο καλά ταίριαξε η παρέα με αυτό που ήθελες από τη βραδιά, από το 1 ως το 5;",
  participation_ease:
    "Πόσο εύκολο ήταν για σένα να μπεις και να συμμετέχεις στη συζήτηση, από το 1 ως το 5;",
  conversation_balance:
    "Πόσο ισορροπημένη ήταν η συζήτηση — είχαν όλοι χώρο να μιλήσουν; Βάλε από 1 ως 5.",
  liked:
    "Υπήρχε κάποιος ή κάποια από την παρέα που σου έκανε ιδιαίτερα καλή εντύπωση;",
  meet_again:
    "Με ποιους από την παρέα θα ήθελες να ξαναβρεθείς σε επόμενο τραπέζι;",
  avoid:
    "Υπάρχει κάποιος ή κάποια που θα προτιμούσες να μην πετύχεις ξανά; Μένει αυστηρά μεταξύ μας.",
  // Second approved wording per goal. `withCampaignReaskCap` substitutes this
  // after the campaign ask has already reached the phone. Application copy:
  // claims only that the goal is still open, never why the prior reply failed.
  event_score_reask:
    "Συγγνώμη, δεν μπορέσαμε να το κρατήσουμε αυτό ως απάντηση 🙏 Πώς σου φάνηκε συνολικά η βραδιά, από το 1 ως το 5;",
  table_fit_reask:
    "Συγγνώμη, δεν μπορέσαμε να το κρατήσουμε αυτό ως απάντηση 🙏 Πόσο καλά ταίριαξε η παρέα με αυτό που ήθελες από τη βραδιά, από το 1 ως το 5;",
  participation_ease_reask:
    "Συγγνώμη, δεν μπορέσαμε να το κρατήσουμε αυτό ως απάντηση 🙏 Πόσο εύκολο ήταν για σένα να μπεις και να συμμετέχεις στη συζήτηση, από το 1 ως το 5;",
  conversation_balance_reask:
    "Συγγνώμη, δεν μπορέσαμε να το κρατήσουμε αυτό ως απάντηση 🙏 Πόσο ισορροπημένη ήταν η συζήτηση — είχαν όλοι χώρο να μιλήσουν; Βάλε από 1 ως 5.",
  liked_reask:
    "Συγγνώμη, δεν μπορέσαμε να το κρατήσουμε αυτό ως απάντηση 🙏 Υπήρχε κάποιος ή κάποια από την παρέα που σου έκανε ιδιαίτερα καλή εντύπωση;",
  meet_again_reask:
    "Συγγνώμη, δεν μπορέσαμε να το κρατήσουμε αυτό ως απάντηση 🙏 Με ποιους από την παρέα θα ήθελες να ξαναβρεθείς σε επόμενο τραπέζι;",
  avoid_reask:
    "Συγγνώμη, δεν μπορέσαμε να το κρατήσουμε αυτό ως απάντηση 🙏 Υπάρχει κάποιος ή κάποια που θα προτιμούσες να μην πετύχεις ξανά; Μένει αυστηρά μεταξύ μας.",
  closing:
    "Τέλεια, ευχαριστούμε πολύ! Ό,τι άλλο θες να μας πεις, είμαστε εδώ. 🙌",
  // Closing copy while an unresolved `safety` reason stands. No cheer, no
  // emoji; the inbox already holds the reason.
  closing_after_safety:
    "Ευχαριστούμε πολύ. Ό,τι μας είπες το έχουμε δει και θα το χειριστούμε με προσοχή. Ό,τι άλλο θες να μας πεις, είμαστε εδώ.",
  // Empty-ladder ending: close without thanks, question, or apology. Planner
  // does not remind a closed conversation.
  declined: "Κανένα πρόβλημα, δεν θα σε ξαναρωτήσουμε. Καλή συνέχεια! 🙂",
  stop_ack: "Έγινε, δεν θα ξαναλάβεις μηνύματα από εμάς σε αυτό το νούμερο.",
  reminder:
    "Καλημέρα {name}! Αν έχεις 2 λεπτά, θα χαρούμε πολύ να μάθουμε πώς σου φάνηκε η βραδιά 🙂 (Γράψε ΣΤΟΠ αν δεν θες μηνύματα.)",
  // Mid-questionnaire nudge: restate the open goal, do not imply we lost prior answers.
  reminder_followup:
    "Γεια σου {name}! Είχαμε μείνει εδώ 🙂 {question} (Γράψε ΣΤΟΠ αν δεν θες μηνύματα.)",
  // Non-text inbound: one notice, or silence looks like they never replied.
  cannot_read_media:
    "Συγγνώμη, δεν μπορούμε ακόμα να ακούσουμε φωνητικά ή να δούμε αρχεία εδώ 🙈 Αν μπορείς, γράψε μας το με λίγες λέξεις!",
} as const satisfies PostEventFeedbackQuestionSetCopy;

export const POST_EVENT_FEEDBACK_QUESTION_SET_V1 = {
  version: 1,
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

const POST_EVENT_FEEDBACK_QUESTION_SET_V2_COPY = {
  ...POST_EVENT_FEEDBACK_QUESTION_SET_V1_COPY,
  intro:
    "Γεια σου {name}! Εδώ η ομάδα του Join The Six 🙂 Έχουμε 6 σύντομες, προαιρετικές ερωτήσεις για τη βραδιά — περίπου 2 λεπτά. Οι απαντήσεις σου μας βοηθούν να φτιάχνουμε καλύτερα τα επόμενα τραπέζια και δεν κοινοποιούνται ατομικά σε άλλους συμμετέχοντες. Μπορείς να παραλείψεις όποια ερώτηση θέλεις. Για να μη λαμβάνεις άλλα μηνύματα feedback στο WhatsApp, γράψε ΣΤΟΠ.",
  meet_again:
    "Με ποιους από την παρέα θα χαιρόσουν να ξαναβρεθείς σε επόμενο τραπέζι;",
  avoid:
    "Υπάρχει κάποιος ή κάποια με τον οποίο θα προτιμούσες να μη βρεθείς ξανά στο ίδιο τραπέζι; Αρκεί το όνομα· δεν χρειάζεται να εξηγήσεις γιατί.",
  // V2 re-asks only where the question wording itself changed.
  meet_again_reask:
    "Συγγνώμη, δεν μπορέσαμε να το κρατήσουμε αυτό ως απάντηση 🙏 Με ποιους από την παρέα θα χαιρόσουν να ξαναβρεθείς σε επόμενο τραπέζι;",
  avoid_reask:
    "Συγγνώμη, δεν μπορέσαμε να το κρατήσουμε αυτό ως απάντηση 🙏 Υπάρχει κάποιος ή κάποια με τον οποίο θα προτιμούσες να μη βρεθείς ξανά στο ίδιο τραπέζι; Αρκεί το όνομα· δεν χρειάζεται να εξηγήσεις γιατί.",
  stop_ack:
    "Έγινε, δεν θα ξαναλάβεις μηνύματα feedback από εμάς σε αυτό το νούμερο.",
} as const satisfies PostEventFeedbackQuestionSetCopy;

export const POST_EVENT_FEEDBACK_QUESTION_SET_V2 = {
  version: 2,
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
      key: "table_fit",
      valueKind: "int",
      subjectless: true,
      skippable: true,
      intMin: 1,
      intMax: 5,
    },
    {
      key: "participation_ease",
      valueKind: "int",
      subjectless: true,
      skippable: true,
      intMin: 1,
      intMax: 5,
    },
    {
      key: "conversation_balance",
      valueKind: "int",
      subjectless: true,
      skippable: true,
      intMin: 1,
      intMax: 5,
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
  noteTypes: POST_EVENT_FEEDBACK_QUESTION_SET_V1.noteTypes,
  copy: POST_EVENT_FEEDBACK_QUESTION_SET_V2_COPY,
} as const satisfies PostEventFeedbackQuestionSetV2;

const POST_EVENT_FEEDBACK_QUESTION_SETS = {
  1: POST_EVENT_FEEDBACK_QUESTION_SET_V1,
  2: POST_EVENT_FEEDBACK_QUESTION_SET_V2,
} as const satisfies Record<
  PostEventFeedbackQuestionSetVersion,
  PostEventFeedbackQuestionSet
>;

export class UnsupportedPostEventFeedbackQuestionSetVersionError extends Error {
  constructor(readonly version: number) {
    super(`Unsupported post-event feedback question-set version: ${version}`);
    this.name = UnsupportedPostEventFeedbackQuestionSetVersionError.name;
  }
}

export function getPostEventFeedbackQuestionSet(
  version: number,
): PostEventFeedbackQuestionSet {
  if (version === 1 || version === 2) {
    return POST_EVENT_FEEDBACK_QUESTION_SETS[version];
  }
  throw new UnsupportedPostEventFeedbackQuestionSetVersionError(version);
}

export type PostEventFeedbackQuestionLaunchSnapshot = {
  questionSetVersion: PostEventFeedbackQuestionSetVersion;
  copy: PostEventFeedbackQuestionSetCopy;
};

export function buildPostEventFeedbackQuestionLaunchSnapshot(
  version: PostEventFeedbackQuestionSetVersion = CURRENT_POST_EVENT_FEEDBACK_QUESTION_SET_VERSION,
): PostEventFeedbackQuestionLaunchSnapshot {
  const questionSet = getPostEventFeedbackQuestionSet(version);
  return {
    questionSetVersion: questionSet.version,
    copy: { ...questionSet.copy },
  };
}

/**
 * Launch snapshot owns live wording. Versioned constants fill missing keys.
 */
export function resolveCampaignCopy(
  questions: Record<string, unknown> | undefined,
  questionSetVersion?: number,
): PostEventFeedbackQuestionSetCopy {
  const stored = questions as
    | {
        questionSetVersion?: unknown;
        copy?: Record<string, unknown>;
      }
    | undefined;
  const storedVersion =
    typeof stored?.questionSetVersion === "number"
      ? stored.questionSetVersion
      : undefined;
  const questionSet = getPostEventFeedbackQuestionSet(
    questionSetVersion ??
      storedVersion ??
      CURRENT_POST_EVENT_FEEDBACK_QUESTION_SET_VERSION,
  );
  const snapshot = stored?.copy;
  const resolved: PostEventFeedbackQuestionSetCopy = {
    ...questionSet.copy,
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

/** One media notice per conversation; the dedupe key absorbs a parallel burst. */
export function createFeedbackMediaNoticeDedupeKey(
  conversationId: string,
): string {
  return `feedback-media-notice-${conversationId}`;
}

/**
 * One durable key per reminder ordinal. A single per-conversation key would
 * absorb every later rung; the ordinal still blocks a concurrent double-send.
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
 * Copy key of the goal's `_reask` variant. Type-derived so a new question
 * cannot ship without its entry in `POST_EVENT_FEEDBACK_COPY_KEYS`.
 */
export function postEventFeedbackReaskCopyKey(
  goal: FeedbackAnswerQuestionKey,
): `${FeedbackAnswerQuestionKey}_reask` {
  return `${goal}_reask`;
}

/** Scored questions carry `value_int`; directed questions do not. */
export function isScoredPostEventFeedbackQuestion(value: string): boolean {
  return (
    isPostEventFeedbackAnswerQuestionKey(value) &&
    getPostEventFeedbackAnswerQuestionDefinition(value)?.valueKind === "int"
  );
}

/**
 * Semantics of a key across shipped versions. A key that changes value kind
 * fails here rather than depending on check order.
 */
export function getPostEventFeedbackAnswerQuestionDefinition(
  key: FeedbackAnswerQuestionKey,
): PostEventFeedbackAnswerQuestionDefinition | undefined {
  const definitions = POST_EVENT_FEEDBACK_QUESTION_SET_VERSIONS.flatMap(
    (version) =>
      getPostEventFeedbackQuestionSet(version).answerQuestions.filter(
        (question) => question.key === key,
      ),
  );
  const [first] = definitions;
  if (!first) {
    return undefined;
  }
  if (
    definitions.some(
      (definition) =>
        definition.valueKind !== first.valueKind ||
        definition.subjectless !== first.subjectless ||
        definition.intMin !== first.intMin ||
        definition.intMax !== first.intMax,
    )
  ) {
    throw new Error(
      `Feedback question ${key} changes semantics across versions`,
    );
  }
  return first;
}

/**
 * `liked` and `meet_again` are the same directed decision said twice. `avoid`
 * is the opposite; a decline of it is ordinary.
 */
export function isAgreeingDirectedPostEventFeedbackQuestion(
  value: string,
): boolean {
  return value === "liked" || value === "meet_again";
}

/** Directed (person) questions, in questionnaire order. */
export const FEEDBACK_DIRECTED_ANSWER_QUESTION_KEYS = [
  "liked",
  "meet_again",
  "avoid",
] as const satisfies readonly FeedbackAnswerQuestionKey[];

export function isDirectedPostEventFeedbackQuestion(
  value: string,
): value is (typeof FEEDBACK_DIRECTED_ANSWER_QUESTION_KEYS)[number] {
  return (FEEDBACK_DIRECTED_ANSWER_QUESTION_KEYS as readonly string[]).includes(
    value,
  );
}

/**
 * Directed keys that recording this one must clear. `avoid` contradicts
 * `liked`/`meet_again` and the reverse; those two do not contradict each other.
 */
export function contradictedPostEventFeedbackQuestionKeys(
  questionKey: FeedbackAnswerQuestionKey,
  availableQuestionKeys: readonly FeedbackAnswerQuestionKey[] = FEEDBACK_ANSWER_QUESTION_KEYS,
): readonly FeedbackAnswerQuestionKey[] {
  const available = new Set(availableQuestionKeys);
  if (questionKey === "avoid") {
    return (["liked", "meet_again"] as const).filter((key) =>
      available.has(key),
    );
  }
  if (questionKey === "liked" || questionKey === "meet_again") {
    return available.has("avoid") ? ["avoid"] : [];
  }
  return [];
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
 * Fits a body to the transcript storage limit (not the 4096 send cap). Sets
 * `truncated` when the tail is cut so the cut is visible.
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
