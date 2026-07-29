import {
  FEEDBACK_ANSWER_QUESTION_KEYS,
  FEEDBACK_NOTE_TYPES,
  type FeedbackAnswerQuestionKey,
  type FeedbackNoteType,
} from "@join-the-six/database";
import { z } from "zod";

import {
  postEventFeedbackRecommendedActionSchema,
  postEventFeedbackSafetyCategorySchema,
  type PostEventFeedbackRecommendedAction,
  type PostEventFeedbackSafetyCategory,
} from "../attention.js";

/**
 * The structured proposal contract for `feedback.extract.v1`.
 *
 * The model proposes; it never persists, sends or decides consent. Every field
 * here is re-validated against the durable transcript, the live D16 candidate
 * set and the already-accepted results before anything is written, so a
 * hallucinated participant id or a fabricated message reference is a rejected
 * proposal rather than a directed edge in the database.
 *
 * Fields are nullable rather than optional and every object is `strict()`:
 * provider structured-output modes require a closed schema with all keys
 * present, and a missing key would otherwise be indistinguishable from an
 * explicit "nothing to report".
 */

/** Bounds keep one malformed generation from becoming a large write batch. */
export const FEEDBACK_EXTRACTION_MAX_ANSWERS = 8;
export const FEEDBACK_EXTRACTION_MAX_NOTES = 5;
/**
 * A guard against a runaway generation, not a statement about how many messages
 * a thought may span.
 *
 * It was 10, which a real burst clears easily: somebody typing in fragments can
 * put a dozen messages inside one quiet window, and an answer that honestly
 * cites all of them failed schema validation, exhausted its retries, and landed
 * in the deterministic fallback — which files a generic note over a complaint
 * about where the tables were. A tighter number does not buy accuracy; it
 * converts accurate citation into a run that could not be read at all.
 *
 * Widening the quiet window puts more fragments in a window, so this bound has
 * to stay ahead of it. The transcript cap (150) is the real ceiling.
 */
export const FEEDBACK_EXTRACTION_MAX_SOURCE_MESSAGES = 40;
/** Matches the `feedback_notes` text check constraint. */
export const FEEDBACK_EXTRACTION_NOTE_MAX_LENGTH = 500;
export const FEEDBACK_EXTRACTION_REPLY_MAX_LENGTH = 1_000;
export const FEEDBACK_EXTRACTION_MENTION_MAX_LENGTH = 120;

/**
 * Transcript message ids are UUIDs in production, but the validator only ever
 * checks membership of the referenced conversation, which is strictly stronger
 * than a format check and lets the offline fixture eval use readable ids.
 */
const messageReferenceSchema = z.string().trim().min(1).max(64);

const sourceMessageIdsSchema = z
  .array(messageReferenceSchema)
  .min(1)
  .max(FEEDBACK_EXTRACTION_MAX_SOURCE_MESSAGES);

const confidenceSchema = z.number().min(0).max(1);

const subjectMentionSchema = z
  .string()
  .trim()
  .min(1)
  .max(FEEDBACK_EXTRACTION_MENTION_MAX_LENGTH)
  .nullable();

export const feedbackExtractionAnswerProposalSchema = z
  .object({
    questionKey: z.enum(FEEDBACK_ANSWER_QUESTION_KEYS),
    /** Only `event_score` carries a value; other questions are directed edges. */
    valueInt: z.number().int().nullable(),
    /** A candidate id the model believes it resolved. Never trusted as given. */
    subjectParticipantId: messageReferenceSchema.nullable(),
    /** The raw name as written by the participant when it could not be resolved. */
    subjectMentionedName: subjectMentionSchema,
    sourceMessageIds: sourceMessageIdsSchema,
    confidence: confidenceSchema,
  })
  .strict()
  .describe(
    "One questionnaire answer extracted from a new participant message. Safety content never replaces this answer.",
  );

/**
 * One verdict per questionnaire goal — the shape that stopped the model
 * omitting things.
 *
 * The answers used to be a free array: "give me the answers you found". An
 * array of one is valid JSON, so a message that plainly answered three goals
 * could come back with one and nothing in the output looked empty, because
 * there was no slot to be empty. The only thing asking for exhaustiveness was
 * English inside a `.describe()`, and on 2026-07-27 Luna read «βαζω 3. η Λιτσα
 * περασε, θα την ξαναεβλεπα. κανεναν οχι», returned the score alone, and then
 * asked about the person it had just been told about.
 *
 * A required key per goal removes the option rather than arguing against it: no
 * conforming response exists that has not said something about `liked`. This
 * forces consideration, not correctness — `not_addressed` can still be wrong —
 * but a wrong field is visible and assertable, where a missing array element is
 * neither.
 */
const goalAnswerSchema = z
  .object({
    /** Only `event_score` carries a value; the rest are directed edges. */
    valueInt: z.number().int().nullable(),
    /** A candidate id the model believes it resolved. Never trusted as given. */
    subjectParticipantId: messageReferenceSchema.nullable(),
    /** The raw name as written, when it could not be resolved. */
    subjectMentionedName: subjectMentionSchema,
    sourceMessageIds: sourceMessageIdsSchema,
    confidence: confidenceSchema,
  })
  .strict();

export const FEEDBACK_EXTRACTION_GOAL_STATUSES = [
  "answered",
  "declined",
  "not_addressed",
  "already_settled",
] as const;

/**
 * Flat on purpose, not a discriminated union.
 *
 * A union is the natural way to say this and the provider will not take it: a
 * strict `response_format` rejects the schema outright with «In
 * context=('properties','goals','properties','event_score'), 'oneOf' is not
 * permitted», which is how the first attempt at this shape failed every call on
 * 2026-07-27. So the discriminator is an enum and the payloads are always-present
 * collections that stay empty when they do not apply. `validate-proposal` checks
 * the combination the union would have made unrepresentable.
 */
const goalVerdictSchema = z
  .object({
    status: z.enum(FEEDBACK_EXTRACTION_GOAL_STATUSES),
    /**
     * A list, because one goal legitimately holds several directed answers:
     * «ο Νίκος, η Ελένη και η Άννα μου άρεσαν» is three `liked` edges from one
     * sentence, and the questionnaire exists to build that graph. Empty unless
     * `status` is `answered`.
     */
    answers: z.array(goalAnswerSchema).max(FEEDBACK_EXTRACTION_MAX_ANSWERS),
    /**
     * The words that declined it, and empty unless `status` is `declined`. D3
     * makes every question skippable, which is exactly why a skip needs
     * provenance: without it, "they didn't want to say" is indistinguishable
     * from the model not having looked.
     */
    declinedSourceMessageIds: z
      .array(messageReferenceSchema)
      .max(FEEDBACK_EXTRACTION_MAX_SOURCE_MESSAGES),
  })
  .strict()
  .describe(
    "What the new messages did to this goal. Fill `answers` only for `answered` and `declinedSourceMessageIds` only for `declined`; `already_settled` is a goal that was already answered or skipped before this run.",
  );

/**
 * Every goal, always. The `satisfies` is the guard: adding a questionnaire goal
 * without adding it here stops compiling, rather than silently reintroducing a
 * goal the model is never asked about.
 */
const goalVerdictShape = {
  event_score: goalVerdictSchema,
  liked: goalVerdictSchema,
  meet_again: goalVerdictSchema,
  avoid: goalVerdictSchema,
} satisfies Record<FeedbackAnswerQuestionKey, typeof goalVerdictSchema>;

const feedbackExtractionGoalVerdictsSchema = z
  .object(goalVerdictShape)
  .strict();

export const feedbackExtractionNoteProposalSchema = z
  .object({
    noteType: z.enum(FEEDBACK_NOTE_TYPES),
    text: z.string().trim().min(1).max(FEEDBACK_EXTRACTION_NOTE_MAX_LENGTH),
    subjectParticipantId: messageReferenceSchema.nullable(),
    subjectMentionedName: subjectMentionSchema,
    sourceMessageIds: sourceMessageIdsSchema,
    confidence: confidenceSchema,
  })
  .strict()
  .describe(
    "One short factual note from a new participant message, including when that message also carries a safety signal.",
  );

export const feedbackExtractionSafetySignalProposalSchema = z
  .object({
    category: postEventFeedbackSafetyCategorySchema,
    recommendedAction: postEventFeedbackRecommendedActionSchema,
    sourceMessageIds: sourceMessageIdsSchema,
    confidence: confidenceSchema,
  })
  .strict()
  .describe(
    "A coarse, non-diagnostic model classification for one or more new participant messages. It is independent of answers and notes.",
  );

export const feedbackExtractionProposalSchema = z
  .object({
    goals: feedbackExtractionGoalVerdictsSchema.describe(
      "Every questionnaire goal, each with its own verdict. A goal answered in the new messages is `answered` even when the same message also describes an incident or asks for a human.",
    ),
    notes: z
      .array(feedbackExtractionNoteProposalSchema)
      .max(FEEDBACK_EXTRACTION_MAX_NOTES)
      .describe(
        "All new ordinary feedback notes. Safety-flavoured testimony remains an ordinary note.",
      ),
    nextGoal: z
      .enum(FEEDBACK_ANSWER_QUESTION_KEYS)
      .nullable()
      .describe(
        "The next unanswered goal after applying this proposal, or null when all goals are terminal.",
      ),
    reply: z
      .string()
      .trim()
      .max(FEEDBACK_EXTRACTION_REPLY_MAX_LENGTH)
      .nullable(),
    handoff: z
      .boolean()
      .describe(
        "True only when the participant explicitly asks to speak with a human. Staff priority is classified by an independent model call.",
      ),
    confidence: confidenceSchema,
  })
  .strict();

export type FeedbackExtractionAnswerProposal = z.infer<
  typeof feedbackExtractionAnswerProposalSchema
>;
export type FeedbackExtractionNoteProposal = z.infer<
  typeof feedbackExtractionNoteProposalSchema
>;
export type FeedbackExtractionSafetySignalProposal = z.infer<
  typeof feedbackExtractionSafetySignalProposalSchema
>;
export type FeedbackExtractionProposal = z.infer<
  typeof feedbackExtractionProposalSchema
>;

export type FeedbackExtractionGoalVerdicts =
  FeedbackExtractionProposal["goals"];

/**
 * Builds a complete verdict set from the goals a caller has something to say
 * about, defaulting the rest to `not_addressed`.
 *
 * Every producer that is not a real model — the scripted burst stub, the loop
 * harness, the fixtures — describes a turn as "these goals were answered". They
 * should not each have to spell out the goals that were not, and a hand-written
 * literal is exactly where a missing key would creep back in.
 */
export function feedbackExtractionGoalVerdicts(input: {
  readonly answered?: readonly FeedbackExtractionAnswerProposal[];
  readonly declined?: readonly {
    readonly questionKey: FeedbackAnswerQuestionKey;
    readonly sourceMessageIds: readonly string[];
  }[];
  readonly alreadySettled?: readonly FeedbackAnswerQuestionKey[];
}): FeedbackExtractionGoalVerdicts {
  const verdicts = Object.fromEntries(
    FEEDBACK_ANSWER_QUESTION_KEYS.map((key) => [
      key,
      {
        status: "not_addressed",
        answers: [],
        declinedSourceMessageIds: [],
      } satisfies FeedbackExtractionGoalVerdict,
    ]),
  ) as unknown as Record<
    FeedbackAnswerQuestionKey,
    FeedbackExtractionGoalVerdict
  >;

  for (const key of input.alreadySettled ?? []) {
    verdicts[key] = {
      status: "already_settled",
      answers: [],
      declinedSourceMessageIds: [],
    };
  }
  for (const decline of input.declined ?? []) {
    verdicts[decline.questionKey] = {
      status: "declined",
      answers: [],
      declinedSourceMessageIds: [...decline.sourceMessageIds],
    };
  }
  // Answers last, and grouped: a goal that is both answered and declined is
  // answered, which is the reading that keeps testimony rather than discarding
  // it, and several answers to one goal accumulate rather than overwrite.
  for (const answer of input.answered ?? []) {
    const existing = verdicts[answer.questionKey];
    verdicts[answer.questionKey] = {
      status: "answered",
      answers: [
        ...(existing.status === "answered" ? existing.answers : []),
        {
          valueInt: answer.valueInt,
          subjectParticipantId: answer.subjectParticipantId,
          subjectMentionedName: answer.subjectMentionedName,
          sourceMessageIds: [...answer.sourceMessageIds],
          confidence: answer.confidence,
        },
      ],
      declinedSourceMessageIds: [],
    };
  }

  return verdicts;
}

type FeedbackExtractionGoalVerdict =
  FeedbackExtractionGoalVerdicts[FeedbackAnswerQuestionKey];

export type FeedbackExtractionActor =
  "bot" | "participant" | "staff" | "system";

export type FeedbackExtractionGoalStatus =
  "pending" | "asked" | "answered" | "skipped";

export interface FeedbackExtractionMessageView {
  readonly id: string;
  readonly seq: number;
  readonly actor: FeedbackExtractionActor;
  /** UTC ISO-8601 timestamp from the durable transcript entry. */
  readonly occurredAt: string;
  readonly text: string;
}

export interface FeedbackExtractionCandidateView {
  readonly participantId: string;
  readonly displayName: string;
}

export interface FeedbackExtractionGoalView {
  readonly key: FeedbackAnswerQuestionKey;
  readonly ordinal: number;
  readonly prompt: string;
  readonly status: FeedbackExtractionGoalStatus;
}

export interface FeedbackExtractionAcceptedAnswerView {
  readonly questionKey: FeedbackAnswerQuestionKey;
  readonly subjectParticipantId: string | null;
  readonly valueInt: number | null;
  /**
   * An operator decided this value by hand, so the run may not replace it.
   *
   * Stated per row rather than read from `extraction_meta` here, because the
   * rules are a pure function of this context: the freeze is a fact about the
   * stored answer, not a jsonb lookup validation is allowed to perform.
   */
  readonly correctedByOperator: boolean;
}

export interface FeedbackExtractionAcceptedNoteView {
  readonly noteType: FeedbackNoteType;
  readonly text: string;
  readonly subjectParticipantId: string | null;
}

/**
 * Everything validation is allowed to consult. It is a plain value so the rule
 * set can be evaluated offline against the WP0 fixtures without a database, a
 * queue or a model provider.
 */
export interface FeedbackExtractionContext {
  readonly respondentParticipantId: string;
  /**
   * What the respondent is called, so a subject naming *them* is recognised as
   * self-reference rather than as a person we failed to find.
   */
  readonly respondentDisplayName: string | null;
  readonly candidates: readonly FeedbackExtractionCandidateView[];
  readonly messages: readonly FeedbackExtractionMessageView[];
  /** Participant testimony after the durable extraction cursor for this run. */
  readonly newParticipantMessageIds: readonly string[];
  readonly goals: readonly FeedbackExtractionGoalView[];
  readonly acceptedAnswers: readonly FeedbackExtractionAcceptedAnswerView[];
  readonly acceptedNotes: readonly FeedbackExtractionAcceptedNoteView[];
  /** Lifecycle, control and opt-in already agreed that the bot may speak. */
  readonly replyAllowed: boolean;
}

export const FEEDBACK_EXTRACTION_REJECTION_REASONS = [
  "unknown_source_message",
  "non_participant_source",
  "stale_source_message",
  "disallowed_question_key",
  "disallowed_note_type",
  "subject_on_subjectless_question",
  "invalid_score",
  "missing_subject",
  "unresolved_subject",
  "subject_is_respondent",
  "duplicate_in_run",
  "already_recorded",
  /**
   * The stored row carries an operator's correction, so the newer reading does
   * not win. The run raises `answer_revision` instead and a human adjudicates.
   */
  "answer_corrected_by_operator",
  "unknown_goal",
  /**
   * `status: "answered"` with nothing in `answers`. A discriminated union would
   * have made this unrepresentable; a strict `response_format` refuses unions,
   * so the combination is checked here instead of being trusted.
   */
  "empty_answered_verdict",
  /**
   * `liked` or `meet_again` declined while the bot has never asked it, in a run
   * that recorded an answer from the same testimony. The participant said
   * something we could keep and the model closed a question nobody put to them
   * — which is what «ο Σωτήρης ήταν οκ, θα τον ξαναέβλεπα άνετα» looks like
   * when only `meet_again` survives it.
   */
  "declined_before_asked",
  /**
   * `handoff: true` from a run that recorded nothing at all, over testimony that
   * still visibly held an answer the questionnaire was asking for.
   *
   * Every other thing the model proposes is checked against the transcript
   * before the application acts on it; the handoff was a bare boolean that went
   * straight through to `markAwaitingHuman`. Μαρία Φλερτατζού wrote «βαζω 5. ο
   * Τάσος ήτανε πολύ ωραίος, θα τον ξαναέβλεπα. κανέναν δε θέλω να αποφύγω» —
   * four goals answered in one sentence — and the run came back with no answers,
   * no notes, no safety signal and a request for a human. Her testimony was lost
   * and an operator was queued to read a flirt.
   *
   * A handoff that has extracted nothing and raised nothing, from words that
   * plainly carried a score or named somebody at the table, is the model giving
   * up rather than duty of care. Naming it here makes the run fail, which is
   * what buys the retry that can still read her answers — and, if no attempt
   * ever does, the deterministic fallback that files a note and points a person
   * at the conversation without promising her a phone call nobody ordered.
   *
   * It deliberately does **not** fire on a handoff that carries an answer, a
   * note or a safety signal, nor on one whose testimony held nothing to extract:
   * «μπορώ να μιλήσω με κάποιον από την ομάδα;» is a request for a person and
   * nothing else, and it must go on working exactly as it does today.
   */
  "handoff_discards_testimony",
] as const;

export type FeedbackExtractionRejectionReason =
  (typeof FEEDBACK_EXTRACTION_REJECTION_REASONS)[number];

export interface FeedbackExtractionRejection {
  /**
   * `handoff` is the one scope that is not a row the run wanted to write. It is
   * a property of the whole proposal, so a rejection in that scope condemns the
   * run rather than one of its results.
   */
  readonly scope: "answer" | "note" | "safety_signal" | "goal" | "handoff";
  readonly reason: FeedbackExtractionRejectionReason;
  readonly questionKey?: FeedbackAnswerQuestionKey;
  readonly noteType?: FeedbackNoteType;
}

export interface ValidatedFeedbackAnswer {
  readonly questionKey: FeedbackAnswerQuestionKey;
  readonly valueInt: number | null;
  readonly subjectParticipantId: string | null;
  readonly sourceMessageIds: readonly string[];
  readonly confidence: number;
}

export interface ValidatedFeedbackNote {
  readonly noteType: FeedbackNoteType;
  readonly text: string;
  readonly subjectParticipantId: string | null;
  readonly sourceMessageIds: readonly string[];
  readonly confidence: number;
  /** D18: a degraded mention is kept, flagged and never guessed into an id. */
  readonly flaggedForReview: boolean;
  readonly unresolvedSubjectName: string | null;
}

export interface ValidatedFeedbackSafetySignal {
  readonly category: PostEventFeedbackSafetyCategory;
  readonly recommendedAction: PostEventFeedbackRecommendedAction;
  readonly sourceMessageIds: readonly string[];
  readonly confidence: number;
}

export const FEEDBACK_EXTRACTION_REPLY_SUPPRESSION_REASONS = [
  "not_permitted",
  "empty",
] as const;

export type FeedbackExtractionReplySuppressionReason =
  (typeof FEEDBACK_EXTRACTION_REPLY_SUPPRESSION_REASONS)[number];

export interface ValidatedFeedbackExtraction {
  readonly answers: readonly ValidatedFeedbackAnswer[];
  readonly notes: readonly ValidatedFeedbackNote[];
  readonly skippedGoals: readonly FeedbackAnswerQuestionKey[];
  readonly nextGoal: FeedbackAnswerQuestionKey | null;
  readonly reply: string | null;
  readonly replySuppressedReason: FeedbackExtractionReplySuppressionReason | null;
  readonly safetySignals: readonly ValidatedFeedbackSafetySignal[];
  readonly handoff: boolean;
  readonly confidence: number;
  readonly rejections: readonly FeedbackExtractionRejection[];
}

/**
 * Neutral acknowledgement for an explicit handoff (D13).
 *
 * It deliberately lives outside the versioned question set: §5 locks the
 * questionnaire copy keys, and this text is not a question. It promises a human
 * follow-up and nothing else — no advice, no triage, no minimisation.
 */
export const POST_EVENT_FEEDBACK_HANDOFF_REPLY =
  "Σε ευχαριστούμε που μας το είπες. Κάποιος από την ομάδα μας θα επικοινωνήσει μαζί σου προσωπικά.";

/**
 * Appended to whatever the run decided to say, when the classifier reports an
 * incident that has actually been **described** — so somebody who has just told
 * us they were treated badly is told what happened with it.
 *
 * Ειρήνη Καταγγελού described being touched under the table. The bot answered
 * warmly, the flag went up, an alert reached staff — and she was told none of
 * it. From where she sat she had handed something hard to a questionnaire that
 * moved on to the next question.
 *
 * Rule 11ε forbids the *model* from promising a human, and still does: a
 * promise it invents is one nobody has to keep. This sentence is the
 * application's, so the promise is made by the code that keeps it.
 *
 * The gate lives in `withSafetyAssurance` and is narrower than "a run raised a
 * signal", which is what it used to be: the signal must not be respondent-source
 * — the line must never reach the person who *is* the incident — and it must
 * cite a message the classifier marked `incidentDescribed`. An announcement
 * («θα σας πω κάτι») raises the flag and earns nothing, because there is nothing
 * to have forwarded yet. Said once per conversation, read off the transcript
 * rather than off a flag, so "once" means the sentence reached their phone.
 */
export const POST_EVENT_FEEDBACK_SAFETY_ASSURANCE =
  "Το προώθησα ήδη στην ομάδα μας και κάποιος θα σου μιλήσει προσωπικά.";

/**
 * The last thing the bot says to somebody who has only ever sworn at it.
 *
 * Sent once, on the run where the hostility counter passes
 * `FEEDBACK_CALM_REPLIES_BEFORE_HOSTILITY_STOP`, and it is the bot's own exit
 * line rather than an answer to anything. Μπάμπης Διπλογαμωσταυρίδης opted in
 * and then spent four clusters on «άντε γαμήσου ρε μαλακισμένο μποτ»; the loop
 * kept answering him calmly because nothing in it could count, and a machine
 * that absorbs a fourth round of abuse and asks for a score again is not being
 * patient, it is being a machine.
 *
 * It says «we» cannot continue and «I» am stopping, in that order, on purpose:
 * the first half is about the conversation and not about him, so it is not a
 * verdict on a person we would then have to defend, and the second half is the
 * bot owning the decision instead of implying he asked for it. He did not ask —
 * that is why `optedIn` and the open lifecycle both stay untouched, and why this
 * is not the STOP acknowledgement.
 *
 * The 🍌 is the owner's and is deliberate. It is the same register as the
 * campaign's own copy (`closing` ends on 🙌, `cannot_read_media` on 🙈) and it
 * is what keeps the line from reading as a formal sanction.
 */
export const POST_EVENT_FEEDBACK_HOSTILITY_STOP_REPLY =
  "Δεν μπορούμε να συνεχίσουμε κουβέντα έτσι, εγώ σταματάω 🍌";

/**
 * The acknowledgement half of the deterministic fallback reply.
 *
 * It is the first sentence of the handoff copy above, reused verbatim rather
 * than newly authored: the fallback runs when the model could not speak, which
 * is the worst moment to invent tone. The run appends the campaign's own
 * current goal question after it, so the participant gets an acknowledgement
 * plus the question the bot was already asking — and the conversation does not
 * stall in silence.
 */
export const POST_EVENT_FEEDBACK_FALLBACK_ACK =
  "Σε ευχαριστούμε που μας το είπες.";

/**
 * The generic note a permanently failed run files (D13, amended).
 *
 * Bounded, non-clinical and deliberately content-free: nothing was extracted,
 * so the note may not characterise what was said. It points an operator at the
 * conversation, which is the only honest thing it can do.
 *
 * It used to read «Πιθανή προσβλητική/ευαίσθητη αναφορά», which is a
 * characterisation — the exact thing the paragraph above forbids — and one the
 * system has no grounds for. A run reaches here for any permanent failure, and
 * `failureCause` is `unknown` for every failure this provider produces, so the
 * note asserted possible offensiveness about text nothing had read. Observed in
 * a rehearsal: a participant who wrote that somebody was pleasant company had
 * «possible offensive reference» filed against her name.
 */
export const POST_EVENT_FEEDBACK_FALLBACK_NOTE_TEXT =
  "Η αυτόματη ανάλυση δεν ολοκληρώθηκε — δείτε τη συζήτηση.";

/**
 * How long a conversation may sit parked on a provider incident before the
 * participant is told something.
 *
 * Thirty minutes, decided by the owner over two hours and over never. Long
 * enough that any ordinary retry ladder has had its chance and the sentence is
 * not sent about a blip; short enough that somebody who answered at midnight is
 * not left until morning believing they were ignored.
 */
export const FEEDBACK_EXTRACTION_PARK_NOTICE_AFTER_MS = 30 * 60_000;

/**
 * The one sentence a parked conversation says, half an hour in.
 *
 * Application copy, like the handoff and safety-assurance lines above and for
 * the same reason: no model composed it, so it cannot drift, and it is sent by
 * the code that knows the run is stuck rather than by one that is guessing.
 *
 * Every clause is a constraint rather than a flourish:
 *
 * - It names no cause. The incident it covers is usually ours — an exhausted
 *   balance, a wrong model id, a provider outage — and on 2026-07-27 thirty-six
 *   people were effectively sent a message about our accounting. «κάτι κόλλησε
 *   από τη δική μας πλευρά» puts the fault on us and stops there. No billing, no
 *   credit, no quota, no provider, and nothing that reads as the participant's
 *   fault.
 * - It says their message is unread, not lost. «δεν το έχουμε δει ακόμα» is the
 *   truth — it is sitting in the transcript behind a cursor — and it is also the
 *   version that does not make somebody re-type a disclosure they worked up to.
 * - It promises no person and no time. Rule 11ε forbids the model from saying
 *   somebody will make contact; this is the application speaking, but the
 *   promise would still be one nobody has to keep, because a parked conversation
 *   deliberately raises no attention. «Θα σου απαντήσουμε» is a promise the
 *   system itself keeps: the retry that answers is already queued.
 * - It says nothing about what we do with what they told us — rule 11στ — so no
 *   sentence here can become an accidental data-handling commitment.
 *
 * Sent at most once per conversation, ever. A parked conversation wakes up every
 * few minutes and a second identical apology six hours later is not care, it is
 * a stuck recording.
 */
export const POST_EVENT_FEEDBACK_EXTRACTION_PARKED_NOTICE =
  "Συγγνώμη, κάτι κόλλησε από τη δική μας πλευρά και δεν έχουμε δει ακόμα το μήνυμά σου. Θα σου απαντήσουμε.";

export const FEEDBACK_REPLY_DEDUPE_PREFIX = "feedback-reply";
export const FEEDBACK_CLOSING_DEDUPE_PREFIX = "feedback-closing";
export const FEEDBACK_HANDOFF_DEDUPE_PREFIX = "feedback-handoff";
export const FEEDBACK_FALLBACK_DEDUPE_PREFIX = "feedback-fallback";
export const FEEDBACK_HOSTILITY_STOP_DEDUPE_PREFIX = "feedback-hostility-stop";
export const FEEDBACK_PARKED_DEDUPE_PREFIX = "feedback-parked";

/**
 * One outbound per conversation per answered testimony position. A replayed run
 * derives the same anchor from the same transcript, so the unique `dedupe_key`
 * absorbs it instead of sending a second message.
 *
 * The anchor is the **last participant message's** `seq`, not the transcript
 * length: the run appends its own reply to the transcript, so a length-based
 * key would change between the original run and a replay that already sees
 * that reply — and a changed key is a second WhatsApp message.
 */
export function createFeedbackReplyDedupeKey(
  conversationId: string,
  testimonySeq: number,
): string {
  return `${FEEDBACK_REPLY_DEDUPE_PREFIX}-${conversationId}-${testimonySeq}`;
}

/** A conversation completes once; its closing copy is sent once. */
export function createFeedbackClosingDedupeKey(conversationId: string): string {
  return `${FEEDBACK_CLOSING_DEDUPE_PREFIX}-${conversationId}`;
}

/** Same testimony anchor as the reply key, for the same replay reason. */
export function createFeedbackHandoffDedupeKey(
  conversationId: string,
  testimonySeq: number,
): string {
  return `${FEEDBACK_HANDOFF_DEDUPE_PREFIX}-${conversationId}-${testimonySeq}`;
}

/**
 * Per conversation, not per testimony — unlike the reply and handoff keys above.
 *
 * The bot bows out of a conversation exactly once, so this is closing copy in
 * shape even though it is not a completion. `awaitingHuman` already stops the
 * next run before it reaches a provider, which means the second send this fences
 * against is not a later turn but a replay of the same run: the counter's
 * compare-and-set has by then already been applied, so a replay recomputes the
 * same decision from the same snapshot and must land on the same key.
 */
export function createFeedbackHostilityStopDedupeKey(
  conversationId: string,
): string {
  return `${FEEDBACK_HOSTILITY_STOP_DEDUPE_PREFIX}-${conversationId}`;
}

/**
 * At most one fallback acknowledgement per conversation. The per-testimony fence
 * (`createFeedbackFallbackDedupeKey`) still absorbs replays of the same dead run;
 * this key is what stops a second participant message during an outage from
 * enqueueing the same apology again.
 */
export function createFeedbackFallbackAckDedupeKey(
  conversationId: string,
): string {
  return `${FEEDBACK_FALLBACK_DEDUPE_PREFIX}-${conversationId}-ack`;
}

/**
 * Per-testimony fence for a dead run's operator effects. The cancelled `system`
 * row is never delivered; it exists so a replayed job does not file a second
 * note or audit event for the same testimony.
 */
export function createFeedbackFallbackDedupeKey(
  conversationId: string,
  testimonySeq: number,
): string {
  return `${FEEDBACK_FALLBACK_DEDUPE_PREFIX}-${conversationId}-${testimonySeq}`;
}

/**
 * One parked-conversation notice, ever, per conversation.
 *
 * Keyed on the conversation alone and deliberately not on a testimony position:
 * the sentence is about our silence, not about one message, and somebody who
 * writes twice during the same outage has not earned a second apology. The
 * document's `extraction.parkedNoticeSentAt` makes the decision once; this makes
 * the send once even if that write is lost between the two.
 */
export function createFeedbackExtractionParkedNoticeDedupeKey(
  conversationId: string,
): string {
  return `${FEEDBACK_PARKED_DEDUPE_PREFIX}-${conversationId}-notice`;
}

/** Placeholder body for the per-testimony fence row — never relayed. */
export const POST_EVENT_FEEDBACK_FALLBACK_FENCE_BODY = "·";
