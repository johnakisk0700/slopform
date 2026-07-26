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
} from "./post-event-feedback-attention.js";

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
 * in the deterministic fallback — which files «Πιθανή προσβλητική/ευαίσθητη
 * αναφορά» over a complaint about where the tables were. A tighter number does
 * not buy accuracy; it converts accurate citation into a bogus safety note.
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
    answers: z
      .array(feedbackExtractionAnswerProposalSchema)
      .max(FEEDBACK_EXTRACTION_MAX_ANSWERS)
      .describe(
        "All new directed questionnaire answers. If the current asked goal is answered, this array must include it even when the same message describes an incident or requests handoff.",
      ),
    notes: z
      .array(feedbackExtractionNoteProposalSchema)
      .max(FEEDBACK_EXTRACTION_MAX_NOTES)
      .describe(
        "All new ordinary feedback notes. Safety-flavoured testimony remains an ordinary note.",
      ),
    /**
     * Goals the participant explicitly declined. D3 locks every question as
     * skippable with no answer row, and without a producer for it a
     * conversation whose remaining answer is «κανένας» could never complete.
     */
    skippedGoals: z
      .array(z.enum(FEEDBACK_ANSWER_QUESTION_KEYS))
      .max(FEEDBACK_ANSWER_QUESTION_KEYS.length),
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
  "unknown_goal",
] as const;

export type FeedbackExtractionRejectionReason =
  (typeof FEEDBACK_EXTRACTION_REJECTION_REASONS)[number];

export interface FeedbackExtractionRejection {
  readonly scope: "answer" | "note" | "safety_signal" | "goal";
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
 */
export const POST_EVENT_FEEDBACK_FALLBACK_NOTE_TEXT =
  "Πιθανή προσβλητική/ευαίσθητη αναφορά — δείτε τη συζήτηση.";

export const FEEDBACK_REPLY_DEDUPE_PREFIX = "feedback-reply";
export const FEEDBACK_CLOSING_DEDUPE_PREFIX = "feedback-closing";
export const FEEDBACK_HANDOFF_DEDUPE_PREFIX = "feedback-handoff";
export const FEEDBACK_FALLBACK_DEDUPE_PREFIX = "feedback-fallback";

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
 * The fallback's key, on the same testimony anchor — and it is the fence for
 * the whole fallback effect, not just the send. The note, the audit event and
 * the operator alert are all written in the transaction that inserts this row,
 * so if the unique key absorbs a replay, none of them happen twice either.
 */
export function createFeedbackFallbackDedupeKey(
  conversationId: string,
  testimonySeq: number,
): string {
  return `${FEEDBACK_FALLBACK_DEDUPE_PREFIX}-${conversationId}-${testimonySeq}`;
}
