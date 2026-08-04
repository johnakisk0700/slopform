import { createZodDto } from "nestjs-zod";
import { z } from "zod";

import {
  FEEDBACK_CAMPAIGN_STATUSES,
  FEEDBACK_CAMPAIGN_SUMMARY_STATUSES,
  FEEDBACK_CAMPAIGN_SUMMARY_TRIGGERS,
} from "@join-the-six/database";

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

export const feedbackCampaignSummaryStatusSchema = z.enum([
  "none",
  ...FEEDBACK_CAMPAIGN_SUMMARY_STATUSES,
]);

export const feedbackCampaignSummarySchema = z
  .object({
    status: feedbackCampaignSummaryStatusSchema,
    body: z.string().nullable(),
    model: z.string().nullable(),
    reasoningEffort: z.string().nullable(),
    isPartial: z.boolean(),
    trigger: z.enum(FEEDBACK_CAMPAIGN_SUMMARY_TRIGGERS).nullable(),
    error: z.string().nullable(),
    attempt: z.number().int().min(1).nullable(),
    openConversationCount: z.number().int().nonnegative().nullable(),
    answerCount: z.number().int().nonnegative().nullable(),
    noteCount: z.number().int().nonnegative().nullable(),
    requestedAt: z.iso.datetime().nullable(),
    generatedAt: z.iso.datetime().nullable(),
    /**
     * Splits the two halves of `pending`, which are one word on screen and two
     * very different operational states underneath.
     *
     * `executionEpoch` counts the executions this durable attempt has started;
     * `claimExpiresAt` is the current lease horizon, nulled the moment a worker
     * releases the claim. A horizon still in the future means a live worker is
     * inside the model call. A null or already-passed horizon on a pending row
     * means nobody is generating right now: epoch `0` is the first run waiting
     * in the queue, and anything higher is a run that stopped without settling,
     * with BullMQ holding the retry behind its backoff.
     *
     * The comparison is against PostgreSQL's clock, which is what grants the
     * lease; the seven-minute horizon is far wider than any clock skew a reader
     * can have. `claimToken` stays server-side — the horizon carries the whole
     * signal without publishing the value that authorizes a write.
     */
    executionEpoch: z.number().int().nonnegative().nullable(),
    claimExpiresAt: z.iso.datetime().nullable(),
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
export class FeedbackCampaignSummaryDto extends createZodDto(
  feedbackCampaignSummarySchema,
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
export type FeedbackCampaignSummaryView = z.infer<
  typeof feedbackCampaignSummarySchema
>;
