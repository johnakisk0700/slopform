import {
  FEEDBACK_ANSWER_QUESTION_KEYS,
  FEEDBACK_NOTE_TYPES,
  type FeedbackAnswerQuestionKey,
  type FeedbackNoteType,
} from "@join-the-six/database";

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
  // V2-only copy. Keeping every known key in each fallback object makes an old
  // sparse campaign snapshot readable without weakening the resolved type.
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
  // The deterministic second ask, one per goal. `withCampaignReaskCap`
  // substitutes this wording when the campaign's own words for the goal have
  // already reached the phone once, so a refused answer earns a re-ask that a
  // person could plausibly have typed instead of the same sentence twice —
  // two byte-identical bodies in a row is what the 2026-08-04 slot-2 rehearsal
  // sent a guest ~70 seconds apart, and the burst grader rightly files that as
  // `duplicate_outbound`.
  //
  // Application copy for the same reason the questions themselves are: this
  // wording goes out precisely when the model's reply could not be trusted, so
  // it must be guaranteed not to lie whichever refusal produced it. The
  // acknowledgement claims only what is always true at that point — the goal
  // is still open, so nothing usable was kept from the previous message. It
  // deliberately does not say *why* (a name we could not place, a score out of
  // range, …), because by the time this fallback fires the reason may be any
  // of them.
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
  // The same ending in the register the conversation was actually held in.
  // Sent instead of `closing` while an unresolved safety reason stands: Νίτσα
  // Κομποσερογιάννη described being pressed for a lift home after saying no
  // twice, asked what happens next — and got «Τέλεια! 🙌», because the cheerful
  // ending is application copy and no register rule governs application copy.
  // No exclamation marks, no emoji, and one commitment the flag mechanism
  // actually keeps: the reason is already in an operator's inbox and stays
  // there until a person resolves it.
  closing_after_safety:
    "Ευχαριστούμε πολύ. Ό,τι μας είπες το έχουμε δει και θα το χειριστούμε με προσοχή. Ό,τι άλλο θες να μας πεις, είμαστε εδώ.",
  // The ending for somebody who declined every question. Πάνος Μούλαρος wrote
  // «δε λεω τιποτα» three times and received nothing at all after the intro —
  // the thank-you is correctly withheld from an empty ladder, and there was
  // nothing behind it. Silence obeys him, but it also leaves him unsure anybody
  // read it, and a closed conversation cannot answer whatever he writes next.
  //
  // No thanks, because there is nothing to thank him for. No question, because
  // he has answered that four times. No apology, because he did nothing wrong.
  // The promise is one we actually keep: the conversation closes, and the
  // conversation planner does not remind a closed one.
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
  // The re-ask variants restate the question, so the two whose V2 wording
  // differs are re-derived here; the rest ask the same words in both versions
  // and ride in on the spread.
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
 * The campaign's launch copy snapshot owns the wording, so a later copy edit
 * never rewrites a live questionnaire. The versioned constant is the fallback
 * when the snapshot is missing or malformed.
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
 * The copy key of a goal's deterministic re-ask variant — the differently
 * worded second ask `withCampaignReaskCap` substitutes when the goal's own
 * campaign copy has already gone out once. A type-level derivation rather than
 * a lookup table, so a new answer question cannot ship without its variant:
 * indexing the copy record with this return type stops compiling until every
 * question key has its `_reask` entry in `POST_EVENT_FEEDBACK_COPY_KEYS`.
 */
export function postEventFeedbackReaskCopyKey(
  goal: FeedbackAnswerQuestionKey,
): `${FeedbackAnswerQuestionKey}_reask` {
  return `${goal}_reask`;
}

/**
 * Whether this question's answer is a number.
 *
 * V1 has one scored goal and V2 has four; the directed goals answer with a
 * person and leave `value_int` null. The distinction decides what an operator
 * correction can mean: there is no number to fix when the answer is who.
 */
export function isScoredPostEventFeedbackQuestion(value: string): boolean {
  return (
    isPostEventFeedbackAnswerQuestionKey(value) &&
    getPostEventFeedbackAnswerQuestionDefinition(value)?.valueKind === "int"
  );
}

/**
 * Resolves the semantics of a globally valid key across all shipped versions.
 * Reusing a key with different value semantics is rejected here instead of
 * making validation depend on whichever version happened to be checked first.
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

/**
 * The questions whose answer is a person, in the order they are asked.
 *
 * The complement of `isScoredPostEventFeedbackQuestion`, named the other way
 * round because two callers want the list rather than the predicate: the
 * operator's «record an answer» route, which accepts exactly these, and the
 * admin screen that groups people under them.
 */
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
 * The answers about one person that recording this one contradicts.
 *
 * «άκυρο, τον Κώστα Π. καλύτερα όχι ξανά» moves a person, it does not add a
 * second opinion about them. `avoid` and the two agreeing questions are the same
 * decision with opposite answers — somebody a participant now wants to steer
 * clear of is not somebody who made a good impression — so recording one has to
 * clear the other, and only the newest position stands. `liked` and `meet_again`
 * do not contradict each other (one decision said twice) and `event_score` is
 * directed at nobody, so neither has anything to clear.
 *
 * One rule with two callers, which is why it lives here rather than in either of
 * them: an extraction run reading a change of heart, and an operator recording
 * the same move by hand.
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
