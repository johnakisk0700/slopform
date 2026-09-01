import {
  EVENT_STATUSES,
  FEEDBACK_CAMPAIGN_STATUSES,
  FEEDBACK_CAMPAIGN_SUMMARY_STATUSES,
} from "@slopform/database";
import { createZodDto } from "nestjs-zod";
import { z } from "zod";

import { POST_EVENT_FEEDBACK_ATTENTION_REASONS } from "../post-event-feedback/attention.js";
import { FEEDBACK_CONVERSATION_LIFECYCLE_REASONS } from "../post-event-feedback/post-event-feedback-conversation.document.js";
import { FEEDBACK_OUTBOX_UNDELIVERED_STATUSES } from "../post-event-feedback/outbox/outbox.repository.js";

const nonNegativeInt = z.number().int().nonnegative();

export const overviewEventStatusCountsSchema = z
  .object({
    draft: nonNegativeInt,
    scheduled: nonNegativeInt,
    finished: nonNegativeInt,
    cancelled: nonNegativeInt,
  })
  .strict()
  .refine(
    (value) => EVENT_STATUSES.every((status) => Object.hasOwn(value, status)),
    { message: "Every event status key must be present" },
  );

export const overviewNextScheduledEventSchema = z
  .object({
    id: z.uuid(),
    title: z.string().min(1).max(200),
    startsAt: z.iso.datetime(),
    attendeeCount: nonNegativeInt,
    venueLabel: z.string().min(1).max(200).nullable(),
  })
  .strict();

export const overviewEventsSchema = z
  .object({
    total: nonNegativeInt,
    byStatus: overviewEventStatusCountsSchema,
    attendeeCount: nonNegativeInt,
    presentCount: nonNegativeInt,
    finishedWithoutFeedbackCampaignCount: nonNegativeInt,
    nextScheduled: overviewNextScheduledEventSchema.nullable(),
  })
  .strict();

export const overviewParticipantsSchema = z
  .object({
    total: nonNegativeInt,
    whatsappFeedbackOptInCount: nonNegativeInt,
    withPhoneCount: nonNegativeInt,
    feedbackContactableCount: nonNegativeInt,
  })
  .strict();

export const overviewCampaignStatusCountsSchema = z
  .object({
    launched: nonNegativeInt,
    paused: nonNegativeInt,
    closed: nonNegativeInt,
  })
  .strict()
  .refine(
    (value) =>
      FEEDBACK_CAMPAIGN_STATUSES.every((status) =>
        Object.hasOwn(value, status),
      ),
    { message: "Every campaign status key must be present" },
  );

export const overviewClosedReasonCountsSchema = z
  .object({
    completed: nonNegativeInt,
    declined: nonNegativeInt,
    stopped: nonNegativeInt,
    expired: nonNegativeInt,
    cancelled: nonNegativeInt,
  })
  .strict()
  .refine(
    (value) =>
      FEEDBACK_CONVERSATION_LIFECYCLE_REASONS.every((reason) =>
        Object.hasOwn(value, reason),
      ),
    { message: "Every closed-reason key must be present" },
  );

export const overviewAttentionReasonCountSchema = z
  .object({
    reason: z.enum(POST_EVENT_FEEDBACK_ATTENTION_REASONS),
    count: nonNegativeInt.positive(),
  })
  .strict();

export const overviewConversationsSchema = z
  .object({
    total: nonNegativeInt,
    open: nonNegativeInt,
    closed: nonNegativeInt,
    byClosedReason: overviewClosedReasonCountsSchema,
    needsAttention: nonNegativeInt,
    extractionParked: nonNegativeInt,
    attentionByReason: z
      .array(overviewAttentionReasonCountSchema)
      .max(POST_EVENT_FEEDBACK_ATTENTION_REASONS.length),
  })
  .strict();

export const overviewOutboxSchema = z
  .object({
    pending: nonNegativeInt,
    held: nonNegativeInt,
    claimed: nonNegativeInt,
    attempting: nonNegativeInt,
    ambiguous: nonNegativeInt,
    sending: nonNegativeInt,
    totalUndelivered: nonNegativeInt,
    oldestUndeliveredAt: z.iso.datetime().nullable(),
    failedLast24Hours: nonNegativeInt,
  })
  .strict()
  .refine(
    (value) =>
      FEEDBACK_OUTBOX_UNDELIVERED_STATUSES.every((status) =>
        Object.hasOwn(value, status),
      ),
    { message: "Every undelivered outbox status key must be present" },
  );

export const overviewSummariesSchema = z
  .object({
    none: nonNegativeInt,
    pending: nonNegativeInt,
    ready: nonNegativeInt,
    failed: nonNegativeInt,
  })
  .strict()
  .refine(
    (value) =>
      FEEDBACK_CAMPAIGN_SUMMARY_STATUSES.every((status) =>
        Object.hasOwn(value, status),
      ) && Object.hasOwn(value, "none"),
    { message: "Summary status keys plus none must be present" },
  );

export const overviewFeedbackSchema = z
  .object({
    campaigns: z
      .object({
        total: nonNegativeInt,
        byStatus: overviewCampaignStatusCountsSchema,
      })
      .strict(),
    conversations: overviewConversationsSchema,
    outbox: overviewOutboxSchema,
    summaries: overviewSummariesSchema,
  })
  .strict();

export const overviewSchema = z
  .object({
    observedAt: z.iso.datetime(),
    events: overviewEventsSchema,
    participants: overviewParticipantsSchema,
    feedback: overviewFeedbackSchema,
  })
  .strict();

export type OverviewView = z.infer<typeof overviewSchema>;
export type OverviewEventsView = z.infer<typeof overviewEventsSchema>;
export type OverviewParticipantsView = z.infer<
  typeof overviewParticipantsSchema
>;
export type OverviewConversationsView = z.infer<
  typeof overviewConversationsSchema
>;
export type OverviewOutboxView = z.infer<typeof overviewOutboxSchema>;
export type OverviewSummariesView = z.infer<typeof overviewSummariesSchema>;

export class OverviewDto extends createZodDto(overviewSchema) {}
