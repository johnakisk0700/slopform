import {
  FEEDBACK_CAMPAIGN_STATUSES,
  FEEDBACK_NOTE_STATUSES,
  FEEDBACK_NOTE_TYPES,
  MESSAGE_OUTBOX_DELIVERY_STATUSES,
  MESSAGE_OUTBOX_STATUSES,
} from "@join-the-six/database";
import { createZodDto } from "nestjs-zod";
import { z } from "zod";

import { FEEDBACK_CONVERSATION_MESSAGE_MAX_TEXT_LENGTH } from "../conversations/feedback-conversation.schemas.js";
import { POST_EVENT_FEEDBACK_ANSWER_QUESTION_KEYS } from "./post-event-feedback-question-set.js";

export const feedbackConversationPrincipalSchema = z.string().min(1).max(200);
export const feedbackConversationCorrelationIdSchema = z
  .string()
  .min(1)
  .max(128);

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
    key: z.enum(POST_EVENT_FEEDBACK_ANSWER_QUESTION_KEYS),
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
    questionKey: z.enum(POST_EVENT_FEEDBACK_ANSWER_QUESTION_KEYS),
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

export const feedbackNoteViewSchema = z
  .object({
    id: z.uuid(),
    campaignId: z.uuid(),
    conversationId: z.uuid(),
    noteType: z.enum(FEEDBACK_NOTE_TYPES),
    text: z.string().min(1).max(500),
    status: z.enum(FEEDBACK_NOTE_STATUSES),
    respondentParticipantId: z.uuid(),
    respondentDisplayName: z.string().min(1).max(200).nullable(),
    subjectParticipantId: z.uuid().nullable(),
    subjectDisplayName: z.string().min(1).max(200).nullable(),
    sourceMessageIds: z.array(z.uuid()).min(1),
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
    questionKey: z.enum(POST_EVENT_FEEDBACK_ANSWER_QUESTION_KEYS).optional(),
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
export class FeedbackNoteViewDto extends createZodDto(feedbackNoteViewSchema) {}

export type FeedbackConversationCapabilities = z.infer<
  typeof feedbackConversationCapabilitiesSchema
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
export type FeedbackNoteView = z.infer<typeof feedbackNoteViewSchema>;
export type FeedbackConversationPrincipal = z.infer<
  typeof feedbackConversationPrincipalSchema
>;
export type FeedbackConversationCorrelationId = z.infer<
  typeof feedbackConversationCorrelationIdSchema
>;

const FeedbackConversationPrincipalDtoBase = createZodDto(
  feedbackConversationPrincipalSchema,
) as unknown as new () => object;
const FeedbackConversationCorrelationIdDtoBase = createZodDto(
  feedbackConversationCorrelationIdSchema,
) as unknown as new () => object;
export class FeedbackConversationPrincipalDto extends FeedbackConversationPrincipalDtoBase {}
export class FeedbackConversationCorrelationIdDto extends FeedbackConversationCorrelationIdDtoBase {}
