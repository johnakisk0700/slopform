import { createZodDto } from "nestjs-zod";
import { z } from "zod";

import { FEEDBACK_CAMPAIGN_STATUSES } from "@join-the-six/database";

export const feedbackCampaignStatusSchema = z.enum(FEEDBACK_CAMPAIGN_STATUSES);

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

/**
 * Compact campaign picker row: event identity, lifecycle and conversation
 * progress counts. Transcripts stay out of the list.
 */
export const feedbackCampaignListItemSchema = z
  .object({
    id: z.uuid(),
    eventId: z.uuid(),
    eventTitle: z.string().min(1).max(200).nullable(),
    status: feedbackCampaignStatusSchema,
    launchedAt: z.iso.datetime(),
    conversationCount: z.number().int().nonnegative(),
    openCount: z.number().int().nonnegative(),
    needsAttentionCount: z.number().int().nonnegative(),
    /**
     * Conversations whose extraction is parked behind a provider outage.
     *
     * Beside `needsAttentionCount` rather than folded into it, exactly as on the
     * campaign detail: that number means «this many want a person», and a parked
     * conversation wants a working provider. The list is also where an outage
     * shows first — it hits every campaign at once — and a screen that can only
     * report it one campaign at a time reports it too late.
     */
    extractionParkedCount: z.number().int().nonnegative(),
  })
  .strict();

export const feedbackCampaignListSchema = z
  .object({
    items: z.array(feedbackCampaignListItemSchema).max(200),
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
export class FeedbackCampaignListDto extends createZodDto(
  feedbackCampaignListSchema,
) {}
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
export type FeedbackCampaignListItemView = z.infer<
  typeof feedbackCampaignListItemSchema
>;
export type FeedbackCampaignListView = z.infer<
  typeof feedbackCampaignListSchema
>;
export type StartFeedbackConversationResultView = z.infer<
  typeof startFeedbackConversationResultSchema
>;
