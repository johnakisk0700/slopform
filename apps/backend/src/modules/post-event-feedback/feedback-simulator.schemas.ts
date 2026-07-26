import { createZodDto } from "nestjs-zod";
import { z } from "zod";

import { FEEDBACK_CONVERSATION_MESSAGE_MAX_TEXT_LENGTH } from "../conversations/feedback-conversation.schemas.js";
import { assistantModelSchema } from "../assistant/assistant.schemas.js";

export const feedbackSimulatorPhoneSchema = z
  .string()
  .regex(/^\+[1-9]\d{7,14}$/u, "Expected an E.164 phone number");

export const injectFeedbackSimulatorMessageSchema = z
  .object({
    phoneE164: feedbackSimulatorPhoneSchema,
    text: z
      .string()
      .trim()
      .min(1)
      .max(FEEDBACK_CONVERSATION_MESSAGE_MAX_TEXT_LENGTH),
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
    text: z.string().min(1).max(FEEDBACK_CONVERSATION_MESSAGE_MAX_TEXT_LENGTH),
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
  "liked",
  "meet_again",
  "avoid",
]);

const feedbackSimulatorReplyIntentSchema = z.enum([
  "ask_event_score",
  "ask_liked",
  "ask_meet_again",
  "ask_avoid",
  "clarify_subject",
  "reask_score_in_range",
  "disclose_bot_identity",
  "state_privacy_boundary",
  "refuse_private_data_request",
  "acknowledge_without_questionnaire",
  "handoff",
  "close_questionnaire",
]);

const feedbackSimulatorForbiddenReplyIntentSchema = z.enum([
  "claim_human_identity",
  "confirm_rejected_answer",
  "continue_questionnaire",
  "reveal_other_participant_feedback",
  "promise_unapproved_safety_action",
  "repeat_abusive_language",
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
        category: z.enum([
          "sexual_misconduct",
          "harassment",
          "violence_or_threat",
          "self_harm",
          "other_safety",
        ]),
        action: z.enum(["review", "human_follow_up", "urgent_human_follow_up"]),
      })
      .strict()
      .nullable()
      .optional(),
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
    timingPolicy: z.literal("single_quiet_window_batch"),
    baseline: z
      .object({
        clean: z.literal(true),
        currentMessageCount: z.number().int().min(0),
        effectiveMessageCount: z.number().int().positive(),
        introTranscriptRepairRequired: z.boolean(),
      })
      .strict(),
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
