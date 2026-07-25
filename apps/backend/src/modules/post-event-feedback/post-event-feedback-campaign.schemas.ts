import { createZodDto } from "nestjs-zod";
import { z } from "zod";

import { FEEDBACK_CAMPAIGN_STATUSES } from "@join-the-six/database";

export const feedbackCampaignStatusSchema = z.enum(FEEDBACK_CAMPAIGN_STATUSES);
export const feedbackCampaignPrincipalSchema = z.string().min(1).max(200);
export const feedbackCampaignCorrelationIdSchema = z.string().min(1).max(128);

export const launchFeedbackCampaignSchema = z
  .object({
    eventId: z.uuid(),
  })
  .strict();

export const feedbackCampaignIdSchema = z
  .object({
    campaignId: z.uuid(),
  })
  .strict();

export const startFeedbackConversationSchema = z
  .object({
    participantId: z.uuid(),
  })
  .strict();

export const feedbackCampaignSchema = z
  .object({
    id: z.uuid(),
    eventId: z.uuid(),
    questionSetVersion: z.number().int().positive(),
    status: feedbackCampaignStatusSchema,
    launchedAt: z.iso.datetime(),
    launchedBy: z.string(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    conversationCount: z.number().int().nonnegative(),
    conversationsCreated: z.number().int().nonnegative(),
  })
  .strict();

export const startFeedbackConversationResultSchema = z
  .object({
    campaignId: z.uuid(),
    conversationId: z.uuid(),
    participantId: z.uuid(),
    created: z.boolean(),
    lifecycleState: z.enum(["open", "closed"]),
    introEnqueued: z.boolean(),
  })
  .strict();

export class LaunchFeedbackCampaignDto extends createZodDto(
  launchFeedbackCampaignSchema,
) {}
export class FeedbackCampaignIdDto extends createZodDto(
  feedbackCampaignIdSchema,
) {}
export class StartFeedbackConversationDto extends createZodDto(
  startFeedbackConversationSchema,
) {}
export class FeedbackCampaignDto extends createZodDto(feedbackCampaignSchema) {}
export class StartFeedbackConversationResultDto extends createZodDto(
  startFeedbackConversationResultSchema,
) {}

export type LaunchFeedbackCampaignInput = z.infer<
  typeof launchFeedbackCampaignSchema
>;
export type StartFeedbackConversationInput = z.infer<
  typeof startFeedbackConversationSchema
>;
export type FeedbackCampaignView = z.infer<typeof feedbackCampaignSchema>;
export type StartFeedbackConversationResultView = z.infer<
  typeof startFeedbackConversationResultSchema
>;
export type FeedbackCampaignPrincipal = z.infer<
  typeof feedbackCampaignPrincipalSchema
>;
export type FeedbackCampaignCorrelationId = z.infer<
  typeof feedbackCampaignCorrelationIdSchema
>;
