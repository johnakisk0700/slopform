import { z } from "zod";

import {
  POST_EVENT_FEEDBACK_ANSWER_QUESTION_KEYS,
  POST_EVENT_FEEDBACK_NOTE_TYPES,
  type PostEventFeedbackAnswerQuestionKey,
  type PostEventFeedbackNoteType,
} from "./post-event-feedback-question-set.js";

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
export const FEEDBACK_EXTRACTION_MAX_SOURCE_MESSAGES = 10;
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
    questionKey: z.enum(POST_EVENT_FEEDBACK_ANSWER_QUESTION_KEYS),
    /** Only `event_score` carries a value; other questions are directed edges. */
    valueInt: z.number().int().nullable(),
    /** A candidate id the model believes it resolved. Never trusted as given. */
    subjectParticipantId: messageReferenceSchema.nullable(),
    /** The raw name as written by the participant when it could not be resolved. */
    subjectMentionedName: subjectMentionSchema,
    sourceMessageIds: sourceMessageIdsSchema,
    confidence: confidenceSchema,
  })
  .strict();

export const feedbackExtractionNoteProposalSchema = z
  .object({
    noteType: z.enum(POST_EVENT_FEEDBACK_NOTE_TYPES),
    text: z.string().trim().min(1).max(FEEDBACK_EXTRACTION_NOTE_MAX_LENGTH),
    subjectParticipantId: messageReferenceSchema.nullable(),
    subjectMentionedName: subjectMentionSchema,
    sourceMessageIds: sourceMessageIdsSchema,
    confidence: confidenceSchema,
  })
  .strict();

export const feedbackExtractionProposalSchema = z
  .object({
    answers: z
      .array(feedbackExtractionAnswerProposalSchema)
      .max(FEEDBACK_EXTRACTION_MAX_ANSWERS),
    notes: z
      .array(feedbackExtractionNoteProposalSchema)
      .max(FEEDBACK_EXTRACTION_MAX_NOTES),
    /**
     * Goals the participant explicitly declined. D3 locks every question as
     * skippable with no answer row, and without a producer for it a
     * conversation whose remaining answer is «κανένας» could never complete.
     */
    skippedGoals: z
      .array(z.enum(POST_EVENT_FEEDBACK_ANSWER_QUESTION_KEYS))
      .max(POST_EVENT_FEEDBACK_ANSWER_QUESTION_KEYS.length),
    nextGoal: z.enum(POST_EVENT_FEEDBACK_ANSWER_QUESTION_KEYS).nullable(),
    reply: z
      .string()
      .trim()
      .max(FEEDBACK_EXTRACTION_REPLY_MAX_LENGTH)
      .nullable(),
    handoff: z.boolean(),
    safetySignal: z.boolean(),
    confidence: confidenceSchema,
  })
  .strict();

export type FeedbackExtractionAnswerProposal = z.infer<
  typeof feedbackExtractionAnswerProposalSchema
>;
export type FeedbackExtractionNoteProposal = z.infer<
  typeof feedbackExtractionNoteProposalSchema
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
  readonly text: string;
}

export interface FeedbackExtractionCandidateView {
  readonly participantId: string;
  readonly displayName: string;
}

export interface FeedbackExtractionGoalView {
  readonly key: PostEventFeedbackAnswerQuestionKey;
  readonly ordinal: number;
  readonly prompt: string;
  readonly status: FeedbackExtractionGoalStatus;
}

export interface FeedbackExtractionAcceptedAnswerView {
  readonly questionKey: PostEventFeedbackAnswerQuestionKey;
  readonly subjectParticipantId: string | null;
  readonly valueInt: number | null;
}

export interface FeedbackExtractionAcceptedNoteView {
  readonly noteType: PostEventFeedbackNoteType;
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
  readonly candidates: readonly FeedbackExtractionCandidateView[];
  readonly messages: readonly FeedbackExtractionMessageView[];
  readonly goals: readonly FeedbackExtractionGoalView[];
  readonly acceptedAnswers: readonly FeedbackExtractionAcceptedAnswerView[];
  readonly acceptedNotes: readonly FeedbackExtractionAcceptedNoteView[];
  /** Lifecycle, control and opt-in already agreed that the bot may speak. */
  readonly replyAllowed: boolean;
}

export const FEEDBACK_EXTRACTION_REJECTION_REASONS = [
  "unknown_source_message",
  "non_participant_source",
  "disallowed_question_key",
  "disallowed_note_type",
  "subject_on_subjectless_question",
  "invalid_score",
  "missing_subject",
  "unresolved_subject",
  "subject_is_respondent",
  "duplicate_in_run",
  "already_recorded",
  "safety_note_suppressed",
  "unknown_goal",
] as const;

export type FeedbackExtractionRejectionReason =
  (typeof FEEDBACK_EXTRACTION_REJECTION_REASONS)[number];

export interface FeedbackExtractionRejection {
  readonly scope: "answer" | "note" | "goal";
  readonly reason: FeedbackExtractionRejectionReason;
  readonly questionKey?: PostEventFeedbackAnswerQuestionKey;
  readonly noteType?: PostEventFeedbackNoteType;
}

export interface ValidatedFeedbackAnswer {
  readonly questionKey: PostEventFeedbackAnswerQuestionKey;
  readonly valueInt: number | null;
  readonly subjectParticipantId: string | null;
  readonly sourceMessageIds: readonly string[];
  readonly confidence: number;
}

export interface ValidatedFeedbackNote {
  readonly noteType: PostEventFeedbackNoteType;
  readonly text: string;
  readonly subjectParticipantId: string | null;
  readonly sourceMessageIds: readonly string[];
  readonly confidence: number;
  /** D18: a degraded mention is kept, flagged and never guessed into an id. */
  readonly flaggedForReview: boolean;
  readonly unresolvedSubjectName: string | null;
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
  readonly skippedGoals: readonly PostEventFeedbackAnswerQuestionKey[];
  readonly nextGoal: PostEventFeedbackAnswerQuestionKey | null;
  readonly reply: string | null;
  readonly replySuppressedReason: FeedbackExtractionReplySuppressionReason | null;
  readonly safetySignal: boolean;
  readonly handoff: boolean;
  readonly confidence: number;
  readonly rejections: readonly FeedbackExtractionRejection[];
}

/**
 * Neutral acknowledgement for a safety signal or an explicit handoff (D13).
 *
 * It deliberately lives outside the versioned question set: §5 locks the
 * questionnaire copy keys, and this text is not a question. It promises a human
 * follow-up and nothing else — no advice, no triage, no minimisation.
 */
export const POST_EVENT_FEEDBACK_HANDOFF_REPLY =
  "Σε ευχαριστούμε που μας το είπες. Κάποιος από την ομάδα μας θα επικοινωνήσει μαζί σου προσωπικά.";

export const FEEDBACK_REPLY_DEDUPE_PREFIX = "feedback-reply";
export const FEEDBACK_CLOSING_DEDUPE_PREFIX = "feedback-closing";
export const FEEDBACK_HANDOFF_DEDUPE_PREFIX = "feedback-handoff";

/**
 * One outbound per conversation per extraction cursor position. A replayed run
 * derives the same cursor from the same transcript, so the unique `dedupe_key`
 * absorbs it instead of sending a second message.
 */
export function createFeedbackReplyDedupeKey(
  conversationId: string,
  cursorSeq: number,
): string {
  return `${FEEDBACK_REPLY_DEDUPE_PREFIX}-${conversationId}-${cursorSeq}`;
}

/** A conversation completes once; its closing copy is sent once. */
export function createFeedbackClosingDedupeKey(conversationId: string): string {
  return `${FEEDBACK_CLOSING_DEDUPE_PREFIX}-${conversationId}`;
}

export function createFeedbackHandoffDedupeKey(
  conversationId: string,
  cursorSeq: number,
): string {
  return `${FEEDBACK_HANDOFF_DEDUPE_PREFIX}-${conversationId}-${cursorSeq}`;
}
