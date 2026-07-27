import {
  FEEDBACK_ANSWER_QUESTION_KEYS,
  FEEDBACK_CAMPAIGN_STATUSES,
  FEEDBACK_NOTE_STATUSES,
  FEEDBACK_NOTE_TYPES,
  MESSAGE_OUTBOX_DELIVERY_STATUSES,
  MESSAGE_OUTBOX_STATUSES,
} from "@join-the-six/database";
import { createZodDto } from "nestjs-zod";
import { z } from "zod";

import {
  correlationIdSchema,
  principalSchema,
} from "../../../infrastructure/auth/auth.schemas.js";
import { FEEDBACK_CONVERSATION_MESSAGE_MAX_TEXT_LENGTH } from "../post-event-feedback-conversation.document.js";
import { feedbackConversationMessageAttentionSchema } from "../attention.js";

export const feedbackConversationCapabilitiesSchema = z
  .object({
    canTakeOver: z.boolean(),
    canResumeBot: z.boolean(),
    canClose: z.boolean(),
    canSendStaffMessage: z.boolean(),
  })
  .strict();

export const feedbackConversationGoalProgressSchema = z
  .object({
    key: z.enum(FEEDBACK_ANSWER_QUESTION_KEYS),
    ordinal: z.number().int().positive(),
    status: z.enum(["pending", "asked", "answered", "skipped"]),
  })
  .strict();

export const feedbackConversationListItemSchema = z
  .object({
    id: z.uuid(),
    campaignId: z.uuid(),
    respondentParticipantId: z.uuid(),
    respondentDisplayName: z.string().min(1).max(200).nullable(),
    phoneAtLaunch: z.string().min(1),
    lifecycle: z
      .object({
        state: z.enum(["open", "closed"]),
        reason: z
          .enum(["completed", "stopped", "expired", "cancelled"])
          .nullable(),
      })
      .strict(),
    control: z
      .object({
        mode: z.enum(["bot", "human"]),
        source: z.enum(["launch", "staff_action", "external_outbound"]),
      })
      .strict(),
    goals: z.array(feedbackConversationGoalProgressSchema).max(10),
    messageCount: z.number().int().nonnegative(),
    lastMessageAt: z.iso.datetime().nullable(),
    lastMessageActor: z
      .enum(["bot", "participant", "staff", "system"])
      .nullable(),
    needsAttention: z.boolean(),
    remindedAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    capabilities: feedbackConversationCapabilitiesSchema,
  })
  .strict();

export const feedbackCampaignInboxSummarySchema = z
  .object({
    id: z.uuid(),
    eventId: z.uuid(),
    eventTitle: z.string().min(1).max(200).nullable(),
    status: z.enum(FEEDBACK_CAMPAIGN_STATUSES),
    questionSetVersion: z.number().int().positive(),
    launchedAt: z.iso.datetime(),
    conversationCount: z.number().int().nonnegative(),
    openCount: z.number().int().nonnegative(),
    needsAttentionCount: z.number().int().nonnegative(),
  })
  .strict();

export const feedbackCampaignConversationsSchema = z
  .object({
    campaign: feedbackCampaignInboxSummarySchema,
    conversations: z.array(feedbackConversationListItemSchema).max(500),
  })
  .strict();

export const feedbackConversationMessageDeliverySchema = z
  .object({
    outboxId: z.uuid(),
    outboxStatus: z.enum(MESSAGE_OUTBOX_STATUSES),
    deliveryStatus: z.enum(MESSAGE_OUTBOX_DELIVERY_STATUSES).nullable(),
    sentAt: z.iso.datetime().nullable(),
    deliveredAt: z.iso.datetime().nullable(),
    readAt: z.iso.datetime().nullable(),
    playedAt: z.iso.datetime().nullable(),
  })
  .strict();

export const feedbackConversationMessageSchema = z
  .object({
    id: z.uuid(),
    seq: z.number().int().positive(),
    actor: z.enum(["bot", "participant", "staff", "system"]),
    text: z.string().min(1).max(FEEDBACK_CONVERSATION_MESSAGE_MAX_TEXT_LENGTH),
    providerMessageId: z.string().min(1).max(200).nullable(),
    ingressId: z.uuid().nullable(),
    outboxId: z.uuid().nullable(),
    attention: feedbackConversationMessageAttentionSchema.nullable(),
    at: z.iso.datetime(),
    delivery: feedbackConversationMessageDeliverySchema.nullable(),
  })
  .strict();

export const feedbackConversationGoalDetailSchema =
  feedbackConversationGoalProgressSchema
    .extend({
      prompt: z.string().min(1).max(500),
    })
    .strict();

/**
 * What the detail pane can honestly say about the delayed extract job.
 *
 * `unreadParticipantMessages` is derived from the conversation document alone
 * (participant turns beyond `extraction.cursorSeq`) and needs no queue access.
 * Queue fields come from BullMQ job state for those unread positions only —
 * the list endpoint must never look them up. A missing job is left as null /
 * false rather than labelled "idle": retention removal, a lost enqueue and
 * "already ran" are indistinguishable once the row is gone.
 */
export const feedbackConversationExtractionSchema = z
  .object({
    unreadParticipantMessages: z.number().int().nonnegative(),
    lastRunAt: z.iso.datetime().nullable(),
    model: z.string().min(1).max(200).nullable(),
    /** Earliest delayed-job due time; null when none of the unread jobs is delayed. */
    nextRunAt: z.iso.datetime().nullable(),
    /** BullMQ `active` — a worker is executing an extract job right now. */
    runInFlight: z.boolean(),
    /**
     * Delayed or waiting (including waiting-children / prioritized). Distinct
     * from `runInFlight`: a job past its quiet window sits here with no due
     * time until a worker picks it up.
     */
    runQueued: z.boolean(),
    lastRunFailed: z.boolean(),
    failedReason: z.string().min(1).max(500).nullable(),
  })
  .strict();

export const feedbackConversationDetailSchema = z
  .object({
    id: z.uuid(),
    campaignId: z.uuid(),
    respondentParticipantId: z.uuid(),
    respondentDisplayName: z.string().min(1).max(200).nullable(),
    phoneAtLaunch: z.string().min(1),
    lifecycle: z
      .object({
        state: z.enum(["open", "closed"]),
        reason: z
          .enum(["completed", "stopped", "expired", "cancelled"])
          .nullable(),
        closedAt: z.iso.datetime().nullable(),
      })
      .strict(),
    control: z
      .object({
        mode: z.enum(["bot", "human"]),
        source: z.enum(["launch", "staff_action", "external_outbound"]),
        changedAt: z.iso.datetime(),
      })
      .strict(),
    goals: z.array(feedbackConversationGoalDetailSchema).max(10),
    messages: z.array(feedbackConversationMessageSchema).max(150),
    extraction: feedbackConversationExtractionSchema,
    needsAttention: z.boolean(),
    remindedAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    capabilities: feedbackConversationCapabilitiesSchema,
  })
  .strict();

export const feedbackAnswerViewSchema = z
  .object({
    id: z.uuid(),
    campaignId: z.uuid(),
    conversationId: z.uuid(),
    questionKey: z.enum(FEEDBACK_ANSWER_QUESTION_KEYS),
    valueInt: z.number().int().min(1).max(5).nullable(),
    respondentParticipantId: z.uuid(),
    respondentDisplayName: z.string().min(1).max(200).nullable(),
    subjectParticipantId: z.uuid().nullable(),
    subjectDisplayName: z.string().min(1).max(200).nullable(),
    sourceMessageIds: z.array(z.uuid()).min(1),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

export const FEEDBACK_NOTE_TEXT_MAX_LENGTH = 500;

/**
 * Who authored a note, as a two-value fact the admin can render.
 *
 * `conversation` covers everything the pipeline produced from participant
 * testimony — a model extraction and the deterministic fallback alike, since
 * both quote a real message. `staff` is an operator writing in their own name.
 * The distinction exists so a staff note can never be read as something a
 * participant said.
 */
export const feedbackNoteOriginSchema = z.enum(["conversation", "staff"]);

export const feedbackNoteViewSchema = z
  .object({
    id: z.uuid(),
    campaignId: z.uuid(),
    conversationId: z.uuid(),
    noteType: z.enum(FEEDBACK_NOTE_TYPES),
    text: z.string().min(1).max(FEEDBACK_NOTE_TEXT_MAX_LENGTH),
    status: z.enum(FEEDBACK_NOTE_STATUSES),
    origin: feedbackNoteOriginSchema,
    respondentParticipantId: z.uuid(),
    respondentDisplayName: z.string().min(1).max(200).nullable(),
    subjectParticipantId: z.uuid().nullable(),
    subjectDisplayName: z.string().min(1).max(200).nullable(),
    // A staff note quotes no message, so the array is empty rather than
    // carrying a borrowed id. Extraction output still cites at least one.
    sourceMessageIds: z.array(z.uuid()),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

export const feedbackConversationResultsSchema = z
  .object({
    answers: z.array(feedbackAnswerViewSchema),
    notes: z.array(feedbackNoteViewSchema),
  })
  .strict();

export const feedbackCampaignResultsQuerySchema = z
  .object({
    questionKey: z.enum(FEEDBACK_ANSWER_QUESTION_KEYS).optional(),
    participantId: z.uuid().optional(),
    reviewStatus: z.enum(FEEDBACK_NOTE_STATUSES).optional(),
  })
  .strict();

export const feedbackCampaignIdParamSchema = z
  .object({
    campaignId: z.uuid(),
  })
  .strict();

export const feedbackConversationIdParamSchema = z
  .object({
    campaignId: z.uuid(),
    conversationId: z.uuid(),
  })
  .strict();

export const feedbackNoteIdParamSchema = z
  .object({
    noteId: z.uuid(),
  })
  .strict();

export const sendFeedbackStaffMessageSchema = z
  .object({
    text: z
      .string()
      .trim()
      .min(1)
      .max(FEEDBACK_CONVERSATION_MESSAGE_MAX_TEXT_LENGTH),
  })
  .strict();

export const updateFeedbackNoteReviewStatusSchema = z
  .object({
    status: z.enum(FEEDBACK_NOTE_STATUSES),
  })
  .strict();

/**
 * A note an operator writes by hand. The subject is optional and, when given,
 * must be a current D16 candidate of the campaign's event — the same rule
 * extraction obeys, so a manual note cannot direct feedback at someone the
 * respondent never sat with.
 */
export const addFeedbackConversationNoteSchema = z
  .object({
    noteType: z.enum(FEEDBACK_NOTE_TYPES),
    text: z.string().trim().min(1).max(FEEDBACK_NOTE_TEXT_MAX_LENGTH),
    subjectParticipantId: z.uuid().optional(),
  })
  .strict();

export class FeedbackCampaignConversationsDto extends createZodDto(
  feedbackCampaignConversationsSchema,
) {}
export class FeedbackConversationDetailDto extends createZodDto(
  feedbackConversationDetailSchema,
) {}
export class FeedbackConversationResultsDto extends createZodDto(
  feedbackConversationResultsSchema,
) {}
export class FeedbackCampaignResultsQueryDto extends createZodDto(
  feedbackCampaignResultsQuerySchema,
) {}
export class FeedbackCampaignIdParamDto extends createZodDto(
  feedbackCampaignIdParamSchema,
) {}
export class FeedbackConversationIdParamDto extends createZodDto(
  feedbackConversationIdParamSchema,
) {}
export class FeedbackNoteIdParamDto extends createZodDto(
  feedbackNoteIdParamSchema,
) {}
export class SendFeedbackStaffMessageDto extends createZodDto(
  sendFeedbackStaffMessageSchema,
) {}
export class UpdateFeedbackNoteReviewStatusDto extends createZodDto(
  updateFeedbackNoteReviewStatusSchema,
) {}
export class AddFeedbackConversationNoteDto extends createZodDto(
  addFeedbackConversationNoteSchema,
) {}
export class FeedbackNoteViewDto extends createZodDto(feedbackNoteViewSchema) {}

export type FeedbackConversationCapabilities = z.infer<
  typeof feedbackConversationCapabilitiesSchema
>;
export type FeedbackConversationExtractionView = z.infer<
  typeof feedbackConversationExtractionSchema
>;
export type FeedbackCampaignConversationsView = z.infer<
  typeof feedbackCampaignConversationsSchema
>;
export type FeedbackConversationDetailView = z.infer<
  typeof feedbackConversationDetailSchema
>;
export type FeedbackConversationResultsView = z.infer<
  typeof feedbackConversationResultsSchema
>;
export type FeedbackCampaignResultsQuery = z.infer<
  typeof feedbackCampaignResultsQuerySchema
>;
export type SendFeedbackStaffMessageInput = z.infer<
  typeof sendFeedbackStaffMessageSchema
>;
export type UpdateFeedbackNoteReviewStatusInput = z.infer<
  typeof updateFeedbackNoteReviewStatusSchema
>;
export type AddFeedbackConversationNoteInput = z.infer<
  typeof addFeedbackConversationNoteSchema
>;
export type FeedbackNoteView = z.infer<typeof feedbackNoteViewSchema>;
export type FeedbackNoteOrigin = z.infer<typeof feedbackNoteOriginSchema>;
export type FeedbackConversationPrincipal = z.infer<typeof principalSchema>;
export type FeedbackConversationCorrelationId = z.infer<
  typeof correlationIdSchema
>;
