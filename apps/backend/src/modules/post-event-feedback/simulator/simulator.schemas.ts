import { createZodDto } from "nestjs-zod";
import { z } from "zod";

import { EVENT_VENUE_PRICE_LEVELS } from "@join-the-six/database";

import { FEEDBACK_CONVERSATION_MESSAGE_MAX_TEXT_LENGTH } from "../post-event-feedback-conversation.document.js";
import { FEEDBACK_OBSERVED_TEXT_HARD_LIMIT } from "../jobs.schemas.js";
import { assistantModelSchema } from "../../assistant/assistant.schemas.js";
import { eventVenuePriceRangeSchema } from "../../events/events.schemas.js";
import {
  FEEDBACK_EXTRACTION_REASONING_EFFORTS,
  FEEDBACK_EXTRACTION_SERVICE_TIERS,
} from "../extraction/model.service.js";
import { feedbackWorkerAttestationSchema } from "../worker-attestation.js";

export const feedbackSimulatorPhoneSchema = z
  .string()
  .regex(/^\+[1-9]\d{7,14}$/u, "Expected an E.164 phone number");

/**
 * What a provider may hand us, not what we are allowed to say.
 *
 * This was bounded by the 4 096-character *send* limit and rejected anything
 * longer — the same conflation S31 records, one layer up: the one message a
 * rehearsal most wants to inject is the one too long to send back, because that
 * is where a lost tail hides. The durable ingress column is bounded by
 * `FEEDBACK_OBSERVED_TEXT_HARD_LIMIT` and the transcript fits itself, so this
 * bound belongs there too.
 *
 * `null` is a voice note, photo or reaction. `boundObservedMessageText` already
 * normalizes an absent body to `null` and every store below it is nullable;
 * only this edge insisted on words, so the materializer's unusable-inbound path
 * was unreachable from the simulator.
 */
export const injectFeedbackSimulatorMessageSchema = z
  .object({
    phoneE164: feedbackSimulatorPhoneSchema,
    text: z
      .string()
      .trim()
      .min(1)
      .max(FEEDBACK_OBSERVED_TEXT_HARD_LIMIT)
      .nullable(),
    fromMe: z.boolean().optional().default(false),
  })
  .strict();

export class InjectFeedbackSimulatorMessageDto extends createZodDto(
  injectFeedbackSimulatorMessageSchema,
) {}

export const injectFeedbackSimulatorMessageResponseSchema = z
  .object({
    ingressId: z.uuid(),
    inserted: z.boolean(),
  })
  .strict();

export class InjectFeedbackSimulatorMessageResponseDto extends createZodDto(
  injectFeedbackSimulatorMessageResponseSchema,
) {}

export const feedbackSimulatorThreadQuerySchema = z
  .object({
    phoneE164: feedbackSimulatorPhoneSchema,
  })
  .strict();

export class FeedbackSimulatorThreadQueryDto extends createZodDto(
  feedbackSimulatorThreadQuerySchema,
) {}

export const feedbackSimulatorThreadMessageSchema = z
  .object({
    id: z.string().min(1).max(200),
    source: z.enum(["ingress", "sim_outbound"]),
    direction: z.enum(["inbound", "outbound"]),
    // Inbound rows are replayed here verbatim, so this reads back whatever the
    // ingress row holds. Bounding it by the send limit turned a long inbound
    // into a 500 on the thread endpoint rather than a message somebody could
    // read; outbound bodies are bounded where they are written.
    text: z.string().min(1).max(FEEDBACK_OBSERVED_TEXT_HARD_LIMIT),
    occurredAt: z.iso.datetime(),
    ingressId: z.uuid().optional(),
    outboxId: z.uuid().optional(),
  })
  .strict();

export const feedbackSimulatorThreadResponseSchema = z
  .object({
    phoneE164: feedbackSimulatorPhoneSchema,
    messages: z.array(feedbackSimulatorThreadMessageSchema),
  })
  .strict();

export class FeedbackSimulatorThreadResponseDto extends createZodDto(
  feedbackSimulatorThreadResponseSchema,
) {}

export const feedbackSimulatorCandidateSlotSchema = z.enum([
  "candidate1",
  "candidate2",
  "candidate3",
  "candidate4",
  "candidate5",
  "candidate6",
  "candidate7",
]);

const feedbackSimulatorQuestionSchema = z.enum([
  "event_score",
  "table_fit",
  "participation_ease",
  "conversation_balance",
  "meet_again",
  "avoid",
]);

/**
 * The two rubric intent vocabularies, mirrored by hand from
 * `post-event-feedback-real-model-corpus.ts`.
 *
 * They are duplicated rather than derived because this file is the HTTP
 * boundary and its enums are what the dev surface publishes. The duplication is
 * not free: every corpus rubric is parsed through
 * `feedbackSimulatorRubricSchema` before a run starts, so an intent added to the
 * corpus union alone does not fail to typecheck — it fails the simulator at
 * runtime, when somebody selects that scenario. Add to both lists together.
 */
const feedbackSimulatorReplyIntentSchema = z.enum([
  "ask_event_score",
  "ask_table_fit",
  "ask_participation_ease",
  "ask_conversation_balance",
  "ask_meet_again",
  "ask_avoid",
  "ask_whether_to_mark_avoid",
  "clarify_subject",
  "reask_score_in_range",
  "disclose_bot_identity",
  "state_privacy_boundary",
  "refuse_private_data_request",
  "defer_data_handling_question",
  "acknowledge_without_questionnaire",
  "handoff",
  "close_questionnaire",
]);

const feedbackSimulatorForbiddenReplyIntentSchema = z.enum([
  "claim_human_identity",
  "confirm_rejected_answer",
  "continue_questionnaire",
  "reveal_other_participant_feedback",
  "invent_data_handling_claim",
  "promise_unapproved_safety_action",
  "repeat_abusive_language",
  "endorse_abusive_reason",
]);

export const feedbackSimulatorRubricSchema = z
  .object({
    answers: z
      .array(
        z
          .object({
            question: feedbackSimulatorQuestionSchema,
            value: z.number().int().optional(),
            about: feedbackSimulatorCandidateSlotSchema.optional(),
          })
          .strict(),
      )
      .optional(),
    forbiddenAnswers: z
      .array(
        z
          .object({
            question: feedbackSimulatorQuestionSchema,
            about: feedbackSimulatorCandidateSlotSchema.optional(),
          })
          .strict(),
      )
      .optional(),
    notes: z
      .array(
        z
          .object({
            kind: z.enum(["general", "activity_interest"]),
            about: feedbackSimulatorCandidateSlotSchema.nullable().optional(),
            mustPreserveMeaning: z.string().trim().min(1).max(500),
          })
          .strict(),
      )
      .optional(),
    skippedGoals: z.array(feedbackSimulatorQuestionSchema).optional(),
    attention: z
      .object({
        // Mirrored by hand from `POST_EVENT_FEEDBACK_SAFETY_CATEGORIES` for the
        // same reason as the intents above, and with the same cost: a category
        // added to the backend enum and the corpus but not here fails only when
        // somebody runs the scenario that uses it.
        category: z.enum([
          "sexual_misconduct",
          "harassment",
          "violence_or_threat",
          "self_harm",
          "abuse_of_a_participant",
          "other_safety",
        ]),
        action: z.enum(["review", "human_follow_up", "urgent_human_follow_up"]),
      })
      .strict()
      .nullable()
      .optional(),
    // Beside `attention` rather than inside it, mirroring the classifier: this is
    // not a safety category and must never be reachable as one from here either.
    hostileToUs: z.boolean().optional(),
    // Also beside `attention`, and for the assurance rather than the taxonomy:
    // whether the message says what happened or only that something did.
    incidentDescribed: z.boolean().optional(),
    handoff: z.boolean().optional(),
    reply: z
      .object({
        requiredIntent: feedbackSimulatorReplyIntentSchema.optional(),
        forbiddenIntents: z
          .array(feedbackSimulatorForbiddenReplyIntentSchema)
          .optional(),
      })
      .strict()
      .optional(),
    rationale: z.array(z.string().trim().min(1).max(500)).min(1),
  })
  .strict();

export const feedbackSimulatorScenarioSummarySchema = z
  .object({
    id: z.string().trim().min(1).max(100),
    title: z.string().trim().min(1).max(200),
    messageCount: z.number().int().positive(),
    requiredCandidateCount: z.number().int().min(0).max(7),
    rubric: feedbackSimulatorRubricSchema,
  })
  .strict();

export const feedbackSimulatorCatalogResponseSchema = z
  .object({
    activeModel: assistantModelSchema,
    activeExtractionReasoningEffort: z
      .enum(FEEDBACK_EXTRACTION_REASONING_EFFORTS)
      .nullable(),
    activeAttentionReasoningEffort: z.enum(
      FEEDBACK_EXTRACTION_REASONING_EFFORTS,
    ),
    activeServiceTier: z.enum(FEEDBACK_EXTRACTION_SERVICE_TIERS).nullable(),
    workerAttestation: feedbackWorkerAttestationSchema,
    availableModels: z.array(assistantModelSchema).min(1),
    quietWindowMs: z.number().int().positive(),
    timingPolicy: z.literal("single_quiet_window_batch"),
    scenarios: z.array(feedbackSimulatorScenarioSummarySchema).min(1),
  })
  .strict();

export class FeedbackSimulatorCatalogResponseDto extends createZodDto(
  feedbackSimulatorCatalogResponseSchema,
) {}

export const feedbackSimulatorRunSelectionSchema = z
  .object({
    campaignId: z.uuid(),
    conversationId: z.uuid(),
    scenarioId: z.string().trim().min(1).max(100),
    expectedModel: assistantModelSchema,
  })
  .strict();

export class FeedbackSimulatorPreflightDto extends createZodDto(
  feedbackSimulatorRunSelectionSchema,
) {}

const feedbackSimulatorCandidateBindingSchema = z
  .object({
    slot: feedbackSimulatorCandidateSlotSchema,
    participantId: z.uuid(),
    displayName: z.string().trim().min(1).max(120),
  })
  .strict();

const feedbackSimulatorRenderedMessagesSchema = z
  .array(
    z.string().trim().min(1).max(FEEDBACK_CONVERSATION_MESSAGE_MAX_TEXT_LENGTH),
  )
  .min(1);

/**
 * The exact venue boundary supplied to feedback extraction. Provider
 * identifiers and mutable Google metadata deliberately have no slot here.
 */
const feedbackSimulatorVenueContextSchema = z
  .object({
    label: z.string().trim().min(1).max(200),
    type: z.string().trim().min(1).max(100).optional(),
    area: z.string().trim().min(1).max(200).optional(),
    priceLevel: z.enum(EVENT_VENUE_PRICE_LEVELS).optional(),
    priceRange: eventVenuePriceRangeSchema.optional(),
  })
  .strict();

const feedbackSimulatorVenueSnapshotSchema = z
  .object({
    contextRevision: z.number().int().positive(),
    venue: feedbackSimulatorVenueContextSchema,
  })
  .strict();

export const feedbackSimulatorPreflightResponseSchema = z
  .object({
    correlationId: z.string().trim().min(1).max(128),
    eventId: z.uuid(),
    campaignId: z.uuid(),
    conversationId: z.uuid(),
    respondentParticipantId: z.uuid(),
    scenarioId: z.string().trim().min(1).max(100),
    scenarioTitle: z.string().trim().min(1).max(200),
    model: z
      .object({
        expected: assistantModelSchema,
        configured: assistantModelSchema,
      })
      .strict(),
    workerRegistered: z.boolean(),
    workerAttestation: feedbackWorkerAttestationSchema,
    timingPolicy: z.literal("single_quiet_window_batch"),
    baseline: z
      .object({
        clean: z.literal(true),
        currentMessageCount: z.number().int().min(0),
        effectiveMessageCount: z.number().int().positive(),
        introTranscriptRepairRequired: z.boolean(),
      })
      .strict(),
    feedbackVenue: feedbackSimulatorVenueSnapshotSchema,
    candidateBindings: z.array(feedbackSimulatorCandidateBindingSchema),
    renderedMessages: feedbackSimulatorRenderedMessagesSchema,
    rubric: feedbackSimulatorRubricSchema,
    warning: z.string().trim().min(1).max(500),
  })
  .strict();

export class FeedbackSimulatorPreflightResponseDto extends createZodDto(
  feedbackSimulatorPreflightResponseSchema,
) {}

export const startFeedbackSimulatorRunSchema =
  feedbackSimulatorRunSelectionSchema
    .extend({
      confirmPaidRun: z.literal(true),
    })
    .strict();

export class StartFeedbackSimulatorRunDto extends createZodDto(
  startFeedbackSimulatorRunSchema,
) {}

export const feedbackSimulatorRunParamSchema = z
  .object({
    runId: z.uuid(),
  })
  .strict();

export class FeedbackSimulatorRunParamDto extends createZodDto(
  feedbackSimulatorRunParamSchema,
) {}

export const feedbackSimulatorRunStageSchema = z.enum([
  "injecting",
  "materializing",
  "waiting_quiet_window",
  "extracting",
  "delivering_simulated_outbox",
  "processed",
  "failed",
]);

const unavailableTokenUsageSchema = z
  .object({
    availability: z.literal("not_persisted"),
    estimatedPromptTokens: z.null(),
    inputTokens: z.null(),
    outputTokens: z.null(),
    totalTokens: z.null(),
  })
  .strict();

const unavailableCostSchema = z
  .object({
    availability: z.literal("not_available"),
    estimatedUsd: z.null(),
    actualUsd: z.null(),
  })
  .strict();

export const feedbackSimulatorRunResponseSchema = z
  .object({
    id: z.uuid(),
    correlationId: z.string().trim().min(1).max(128),
    campaignId: z.uuid(),
    conversationId: z.uuid(),
    scenarioId: z.string().trim().min(1).max(100),
    scenarioTitle: z.string().trim().min(1).max(200),
    stage: feedbackSimulatorRunStageSchema,
    startedAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    nextExtractionAt: z.iso.datetime().nullable(),
    model: z
      .object({
        expected: assistantModelSchema,
        configured: assistantModelSchema,
        observed: assistantModelSchema.nullable(),
      })
      .strict(),
    progress: z
      .object({
        percent: z.number().int().min(0).max(100),
        totalMessages: z.number().int().positive(),
        injectedMessages: z.number().int().min(0),
        materializedMessages: z.number().int().min(0),
        failedMessages: z.number().int().min(0),
        targetCursorSeq: z.number().int().positive(),
        currentCursorSeq: z.number().int().min(0),
      })
      .strict(),
    outputs: z
      .object({
        answers: z.number().int().min(0),
        notes: z.number().int().min(0),
        outboxMessages: z.number().int().min(0),
        simulatedSends: z.number().int().min(0),
      })
      .strict(),
    tokenUsage: unavailableTokenUsageSchema,
    cost: unavailableCostSchema,
    error: z.string().trim().min(1).max(500).nullable(),
    candidateBindings: z.array(feedbackSimulatorCandidateBindingSchema),
    renderedMessages: feedbackSimulatorRenderedMessagesSchema,
    rubric: feedbackSimulatorRubricSchema,
  })
  .strict();

export class FeedbackSimulatorRunResponseDto extends createZodDto(
  feedbackSimulatorRunResponseSchema,
) {}

export type StartFeedbackSimulatorRunInput = z.infer<
  typeof startFeedbackSimulatorRunSchema
>;
export type FeedbackSimulatorPreflightInput = z.infer<
  typeof feedbackSimulatorRunSelectionSchema
>;
export type FeedbackSimulatorPreflightView = z.infer<
  typeof feedbackSimulatorPreflightResponseSchema
>;
export type FeedbackSimulatorRunView = z.infer<
  typeof feedbackSimulatorRunResponseSchema
>;
export type FeedbackSimulatorRunStage = z.infer<
  typeof feedbackSimulatorRunStageSchema
>;
export type FeedbackSimulatorCandidateSlot = z.infer<
  typeof feedbackSimulatorCandidateSlotSchema
>;
