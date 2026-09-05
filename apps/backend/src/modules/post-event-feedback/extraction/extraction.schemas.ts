import {
  FEEDBACK_ANSWER_QUESTION_KEYS,
  FEEDBACK_NOTE_TYPES,
  type FeedbackAnswerQuestionKey,
  type FeedbackNoteType,
} from "@slopform/database";
import { z } from "zod";

import type { EventFeedbackVenueContext } from "../../events/event-venue.js";

import {
  postEventFeedbackRecommendedActionSchema,
  postEventFeedbackSafetyCategorySchema,
  type PostEventFeedbackRecommendedAction,
  type PostEventFeedbackSafetyCategory,
} from "../attention.js";

/**
 * Structured extraction proposal. The model never persists, sends or decides
 * consent. Fields are nullable and objects are `strict()` so a missing key is
 * not "nothing to report".
 */

/** Bounds keep one malformed generation from becoming a large write batch. */
export const FEEDBACK_EXTRACTION_MAX_ANSWERS = 8;
export const FEEDBACK_EXTRACTION_MAX_NOTES = 5;
/**
 * Citation-list ceiling, not a thought-span limit. Stay ahead of the quiet
 * window; the transcript cap (150) is the real ceiling.
 */
export const FEEDBACK_EXTRACTION_MAX_SOURCE_MESSAGES = 40;
/** Matches the `feedback_notes` text check constraint. */
export const FEEDBACK_EXTRACTION_NOTE_MAX_LENGTH = 500;
export const FEEDBACK_EXTRACTION_REPLY_MAX_LENGTH = 1_000;
export const FEEDBACK_EXTRACTION_MENTION_MAX_LENGTH = 120;

/** Membership in this conversation is the real check; fixtures may use readable ids. */
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
    /** Scored questions carry a value; directed questions carry a subject. */
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
 * One required verdict per goal. A free answers array could omit goals without
 * looking empty; `not_addressed` is still allowed but visible.
 */
const goalAnswerSchema = z
  .object({
    /** Scored questions carry a value; directed questions carry a subject. */
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
 * Flat enum + always-present collections. Providers reject `oneOf` in
 * `response_format`; `validate-proposal` checks the combinations.
 */
const goalVerdictSchema = z
  .object({
    status: z.enum(FEEDBACK_EXTRACTION_GOAL_STATUSES),
    /** Directed answers for this goal. Empty unless `status` is `answered`. */
    answers: z.array(goalAnswerSchema).max(FEEDBACK_EXTRACTION_MAX_ANSWERS),
    /** Decline citations. Empty unless `status` is `declined`. */
    declinedSourceMessageIds: z
      .array(messageReferenceSchema)
      .max(FEEDBACK_EXTRACTION_MAX_SOURCE_MESSAGES),
  })
  .strict()
  .describe(
    "What the new messages did to this goal. Fill `answers` only for `answered` and `declinedSourceMessageIds` only for `declined`; `already_settled` is a goal that was already answered or skipped before this run.",
  );

/** Legacy static export defaults to V1; runtime generation is per conversation. */
export const FEEDBACK_EXTRACTION_V1_GOAL_KEYS = [
  "event_score",
  "liked",
  "meet_again",
  "avoid",
] as const satisfies readonly FeedbackAnswerQuestionKey[];

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

export type FeedbackExtractionAnswerProposal = z.infer<
  typeof feedbackExtractionAnswerProposalSchema
>;
export type FeedbackExtractionNoteProposal = z.infer<
  typeof feedbackExtractionNoteProposalSchema
>;
export type FeedbackExtractionSafetySignalProposal = z.infer<
  typeof feedbackExtractionSafetySignalProposalSchema
>;
export type FeedbackExtractionGoalAnswer = z.infer<typeof goalAnswerSchema>;

export interface FeedbackExtractionGoalVerdict {
  readonly status: (typeof FEEDBACK_EXTRACTION_GOAL_STATUSES)[number];
  readonly answers: readonly FeedbackExtractionGoalAnswer[];
  readonly declinedSourceMessageIds: readonly string[];
}

export type FeedbackExtractionGoalVerdicts = Partial<
  Record<FeedbackAnswerQuestionKey, FeedbackExtractionGoalVerdict>
>;

export interface FeedbackExtractionProposal {
  readonly goals: FeedbackExtractionGoalVerdicts;
  readonly notes: readonly FeedbackExtractionNoteProposal[];
  readonly nextGoal: FeedbackAnswerQuestionKey | null;
  readonly reply: string | null;
  readonly handoff: boolean;
  readonly confidence: number;
}

/**
 * Provider schema from the conversation's stored goals. No fictional padding.
 */
export function createFeedbackExtractionProposalSchema(
  questionKeys: readonly FeedbackAnswerQuestionKey[],
): z.ZodType<FeedbackExtractionProposal> {
  const uniqueKeys = [...new Set(questionKeys)];
  if (uniqueKeys.length === 0 || uniqueKeys.length !== questionKeys.length) {
    throw new Error(
      "Feedback extraction schema requires a non-empty unique question-key set",
    );
  }

  const goalVerdictShape = Object.fromEntries(
    uniqueKeys.map((key) => [key, goalVerdictSchema]),
  ) as Record<FeedbackAnswerQuestionKey, typeof goalVerdictSchema>;
  const feedbackExtractionGoalVerdictsSchema = z
    .object(goalVerdictShape)
    .strict();
  const nextGoalSchema = z.enum(
    uniqueKeys as [FeedbackAnswerQuestionKey, ...FeedbackAnswerQuestionKey[]],
  );

  return z
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
      nextGoal: nextGoalSchema
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
    .strict() as unknown as z.ZodType<FeedbackExtractionProposal>;
}

/** V1 fixture / no-campaign compatibility. Production uses the factory above. */
export const feedbackExtractionProposalSchema =
  createFeedbackExtractionProposalSchema(FEEDBACK_EXTRACTION_V1_GOAL_KEYS);

/**
 * Completes a verdict set, defaulting unmentioned goals to `not_addressed`.
 */
export function feedbackExtractionGoalVerdicts(
  input: {
    readonly answered?: readonly FeedbackExtractionAnswerProposal[];
    readonly declined?: readonly {
      readonly questionKey: FeedbackAnswerQuestionKey;
      readonly sourceMessageIds: readonly string[];
    }[];
    readonly alreadySettled?: readonly FeedbackAnswerQuestionKey[];
  },
  questionKeys: readonly FeedbackAnswerQuestionKey[] = FEEDBACK_EXTRACTION_V1_GOAL_KEYS,
): FeedbackExtractionGoalVerdicts {
  const allowedKeys = new Set(questionKeys);
  const verdicts = Object.fromEntries(
    questionKeys.map((key) => [
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

  const assertedKeys = [
    ...(input.alreadySettled ?? []),
    ...(input.declined ?? []).map((decline) => decline.questionKey),
    ...(input.answered ?? []).map((answer) => answer.questionKey),
  ];
  for (const key of assertedKeys) {
    if (!allowedKeys.has(key)) {
      throw new Error(
        `Feedback verdict key ${key} is not in this question set`,
      );
    }
  }

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
  // Answers last and grouped: answered wins over declined; accumulate.
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
  /** Operator freeze. Stated on the row; validation does not read jsonb. */
  readonly correctedByOperator: boolean;
}

export interface FeedbackExtractionAcceptedNoteView {
  readonly noteType: FeedbackNoteType;
  readonly text: string;
  readonly subjectParticipantId: string | null;
}

/**
 * Everything validation may consult. A plain value so the rules run offline.
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
  /**
   * Fallible operator context for conversational coherence only. Google Place
   * identity and live metadata are excluded by the events-module boundary.
   */
  readonly venue?: EventFeedbackVenueContext | null;
  /** Present only when this run actually supplied venue context to the model. */
  readonly venueContextRevision?: number | null;
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
  /** Operator-corrected row: refuse overwrite and raise `answer_revision`. */
  "answer_corrected_by_operator",
  "unknown_goal",
  /** A proposal bypassed the per-conversation schema and omitted a real goal. */
  "missing_goal_verdict",
  /** `answered` with an empty `answers` list. */
  "empty_answered_verdict",
  /**
   * V1: `liked`/`meet_again` declined while still `pending` in a run that
   * recorded another answer from the same testimony.
   */
  "declined_before_asked",
  /**
   * Handoff with nothing recorded over testimony that still holds an askable
   * answer. Fails the run so retry (then fallback) can still read it. Does not
   * fire when an answer, note, safety signal or `already_recorded` is present,
   * nor on a plain "speak to a person" with nothing to extract.
   */
  "handoff_discards_testimony",
] as const;

export type FeedbackExtractionRejectionReason =
  (typeof FEEDBACK_EXTRACTION_REJECTION_REASONS)[number];

export interface FeedbackExtractionRejection {
  /**
   * `handoff` rejects the whole run, not one result row.
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
 * Neutral explicit-handoff copy (D13). Not a questionnaire key.
 */
export const POST_EVENT_FEEDBACK_HANDOFF_REPLY =
  "Σε ευχαριστούμε που μας το είπες. Κάποιος από την ομάδα μας θα επικοινωνήσει μαζί σου προσωπικά.";

/**
 * Application-owned assurance. Gate is `withSafetyAssurance`: non-respondent-
 * source + `incidentDescribed`, not already on the transcript, not handoff copy.
 */
export const POST_EVENT_FEEDBACK_SAFETY_ASSURANCE =
  "Το προώθησα ήδη στην ομάδα μας και κάποιος θα σου μιλήσει προσωπικά.";

/**
 * Application-owned hostility exit line. Sent once when the counter passes
 * `FEEDBACK_CALM_REPLIES_BEFORE_HOSTILITY_STOP`. Not STOP: `optedIn` and
 * lifecycle stay open.
 */
export const POST_EVENT_FEEDBACK_HOSTILITY_STOP_REPLY =
  "Δεν μπορούμε να συνεχίσουμε κουβέντα έτσι, εγώ σταματάω 🍌";

/**
 * First sentence of the handoff copy, reused as the fallback acknowledgement.
 */
export const POST_EVENT_FEEDBACK_FALLBACK_ACK =
  "Σε ευχαριστούμε που μας το είπες.";

/**
 * Generic fallback note (D13). Content-free: nothing was extracted, so nothing
 * may be characterised.
 */
export const POST_EVENT_FEEDBACK_FALLBACK_NOTE_TEXT =
  "Η αυτόματη ανάλυση δεν ολοκληρώθηκε — δείτε τη συζήτηση.";

/** Park notice delay: after ordinary retries, before overnight silence. */
export const FEEDBACK_EXTRACTION_PARK_NOTICE_AFTER_MS = 30 * 60_000;

/**
 * One parked-conversation notice. No cause, person, time or data-handling
 * claim. Sent at most once per conversation.
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
 * One outbound per conversation per last-participant `seq`. Length would change
 * after this run appends its reply and mint a second WhatsApp message.
 */
export function createFeedbackReplyDedupeKey(
  conversationId: string,
  testimonySeq: number,
): string {
  return `${FEEDBACK_REPLY_DEDUPE_PREFIX}-${conversationId}-${testimonySeq}`;
}

/**
 * Closing identity includes `workRevision` so a takeover-cancelled terminal
 * does not block resume. Execution epoch is deliberately absent. Optional
 * revision is for retained V2 / pure outbound resolution only.
 */
export function createFeedbackClosingDedupeKey(
  conversationId: string,
  testimonySeq: number,
  workRevision?: number,
): string {
  const testimonyIdentity = `${FEEDBACK_CLOSING_DEDUPE_PREFIX}-${conversationId}-${testimonySeq}`;
  return workRevision === undefined
    ? testimonyIdentity
    : `${testimonyIdentity}-r${workRevision}`;
}

/** Accepts generation-bearing V3, testimony-only V2 and fixed V1 identities. */
export function isFeedbackClosingDedupeKey(
  conversationId: string,
  dedupeKey: string,
): boolean {
  const legacy = `${FEEDBACK_CLOSING_DEDUPE_PREFIX}-${conversationId}`;
  if (dedupeKey === legacy) return true;
  const suffix = dedupeKey.slice(legacy.length + 1);
  const anchored = /^(\d+)(?:-r(\d+))?$/u.exec(suffix);
  if (!dedupeKey.startsWith(`${legacy}-`) || !anchored) return false;
  const testimonySeq = Number(anchored[1]);
  const workRevision =
    anchored[2] === undefined ? undefined : Number(anchored[2]);
  return (
    Number.isSafeInteger(testimonySeq) &&
    testimonySeq > 0 &&
    (workRevision === undefined ||
      (Number.isSafeInteger(workRevision) && workRevision >= 0))
  );
}

/** Same testimony anchor as the reply key, for the same replay reason. */
export function createFeedbackHandoffDedupeKey(
  conversationId: string,
  testimonySeq: number,
): string {
  return `${FEEDBACK_HANDOFF_DEDUPE_PREFIX}-${conversationId}-${testimonySeq}`;
}

/**
 * One hostility-stop send per conversation. Replay of the same run must reuse
 * this key after the counter CAS has already applied.
 */
export function createFeedbackHostilityStopDedupeKey(
  conversationId: string,
): string {
  return `${FEEDBACK_HOSTILITY_STOP_DEDUPE_PREFIX}-${conversationId}`;
}

/** One fallback ack per conversation. Per-testimony fence absorbs same-run replay. */
export function createFeedbackFallbackAckDedupeKey(
  conversationId: string,
): string {
  return `${FEEDBACK_FALLBACK_DEDUPE_PREFIX}-${conversationId}-ack`;
}

/** Cancelled per-testimony fence: replay must not file a second note/audit. */
export function createFeedbackFallbackDedupeKey(
  conversationId: string,
  testimonySeq: number,
): string {
  return `${FEEDBACK_FALLBACK_DEDUPE_PREFIX}-${conversationId}-${testimonySeq}`;
}

/**
 * One parked notice per conversation, not per testimony. Complements
 * `parkedNoticeSentAt` if that write is lost.
 */
export function createFeedbackExtractionParkedNoticeDedupeKey(
  conversationId: string,
): string {
  return `${FEEDBACK_PARKED_DEDUPE_PREFIX}-${conversationId}-notice`;
}

/** Placeholder body for the per-testimony fence row — never relayed. */
export const POST_EVENT_FEEDBACK_FALLBACK_FENCE_BODY = "·";
