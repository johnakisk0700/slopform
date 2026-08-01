import {
  FEEDBACK_CAMPAIGN_STATUSES,
  MESSAGE_OUTBOX_DELIVERY_STATUSES,
  MESSAGE_OUTBOX_KINDS,
  MESSAGE_OUTBOX_LOG_ORIGINS,
  MESSAGE_OUTBOX_STATUSES,
} from "@join-the-six/database";
import { createZodDto } from "nestjs-zod";
import { z } from "zod";

import { FEEDBACK_DELIVER_JOB_STATES } from "./inspect-deliver-job.js";
import { feedbackOutboundDecisionSchema } from "./outbound-log.schemas.js";
import { outboundConversationSnapshotSchema } from "./outbound-log.snapshot.js";
import {
  FEEDBACK_OUTBOX_QUEUE_VIEW_LIMIT,
  FEEDBACK_OUTBOX_UNDELIVERED_STATUSES,
} from "./outbox.repository.js";

/**
 * One outbound message the participant does not have yet.
 *
 * Every field is read from PostgreSQL — `message_outbox` joined to its campaign
 * and event, plus one batched MongoDB read for the respondent. Nothing here
 * touches Redis, because this list is polled and a queue connection per row is
 * how an observability screen becomes the outage it was built to watch.
 */
export const feedbackOutboxQueueItemSchema = z
  .object({
    id: z.uuid(),
    conversationId: z.uuid(),
    campaignId: z.uuid(),
    eventId: z.uuid(),
    eventTitle: z.string().min(1).max(200),
    /**
     * The relay leases nothing for a campaign that is not `launched`, so this
     * is what separates "the system is behind" from "an operator paused it".
     */
    campaignStatus: z.enum(FEEDBACK_CAMPAIGN_STATUSES),
    kind: z.enum(MESSAGE_OUTBOX_KINDS),
    status: z.enum(FEEDBACK_OUTBOX_UNDELIVERED_STATUSES),
    deliveryStatus: z.enum(MESSAGE_OUTBOX_DELIVERY_STATUSES).nullable(),
    /**
     * Age in whole seconds, measured against `observedAt` on the server.
     *
     * The number is computed here rather than from `createdAt` in the browser
     * because a skewed client clock would silently misreport the one figure
     * this screen exists to show. The poll interval is the resolution.
     */
    waitingSeconds: z.number().int().nonnegative(),
    /** Null when the conversation document is missing (D18 renders instead). */
    respondentParticipantId: z.uuid().nullable(),
    respondentDisplayName: z.string().min(1).max(200).nullable(),
    phoneAtLaunch: z.string().min(1).max(50).nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

export const feedbackOutboxQueueSchema = z
  .object({
    /** The server clock every `waitingSeconds` was measured against. */
    observedAt: z.iso.datetime(),
    /** Totals across the whole table, so a capped page cannot imply a total. */
    counts: z
      .object({
        pending: z.number().int().nonnegative(),
        sending: z.number().int().nonnegative(),
        held: z.number().int().nonnegative(),
        total: z.number().int().nonnegative(),
      })
      .strict(),
    /** True when `counts.total` exceeds what `items` could carry. */
    truncated: z.boolean(),
    items: z
      .array(feedbackOutboxQueueItemSchema)
      .max(FEEDBACK_OUTBOX_QUEUE_VIEW_LIMIT),
  })
  .strict();

/**
 * One row of the outbound history — any status, newest first.
 *
 * The queue item's shape minus the two queue-only readings: `waitingSeconds`
 * measures a wait that is over for a terminal row, and the undelivered status
 * enum widens to every status the table allows. `origin` is the decision log's
 * one-word answer to «why does this row exist», batched from
 * `message_outbox_log` in a single read; null marks a row older than the log.
 */
export const feedbackOutboxHistoryItemSchema = feedbackOutboxQueueItemSchema
  .omit({ status: true, waitingSeconds: true })
  .extend({
    status: z.enum(MESSAGE_OUTBOX_STATUSES),
    origin: z.enum(MESSAGE_OUTBOX_LOG_ORIGINS).nullable(),
  })
  .strict();

export const feedbackOutboxHistorySchema = z
  .object({
    observedAt: z.iso.datetime(),
    /** Rows ever written, so the capped page cannot imply a total. */
    total: z.number().int().nonnegative(),
    /** True when `total` exceeds what `items` could carry. */
    truncated: z.boolean(),
    items: z
      .array(feedbackOutboxHistoryItemSchema)
      .max(FEEDBACK_OUTBOX_QUEUE_VIEW_LIMIT),
  })
  .strict();

/**
 * The live BullMQ state of one `feedback.deliver.v1` job.
 *
 * `unknown` is a first-class answer and the ordinary one: delivery jobs carry
 * `attempts: 1` with immediate `removeOnComplete` / `removeOnFail`, so the job
 * exists only between the relay's lease and the consumer's last line. A
 * `pending` row that has not been leased, a job that finished a moment ago and
 * a job that was lost are one indistinguishable read.
 */
export const feedbackOutboxDeliverJobSchema = z
  .object({
    /** The deterministic job id, so an operator can find it in Bull Board. */
    id: z.string().min(1).max(200),
    state: z.enum(FEEDBACK_DELIVER_JOB_STATES),
    /**
     * BullMQ's attempt counter. It is *not* a delivery attempt history: the
     * job row is deleted when it terminates and re-added under the same id on
     * the next relay lease, so this counter restarts at zero each time.
     */
    attemptsMade: z.number().int().nonnegative().nullable(),
    // `.min(1)`, not `.positive()`: a nullable `positive()` emits the JSON
    // Schema 2020-12 form of `exclusiveMinimum`, which the OpenAPI 3.0
    // validator orval runs rejects. The bound is identical.
    attemptsAllowed: z.number().int().min(1).nullable(),
    enqueuedAt: z.iso.datetime().nullable(),
    /** When a `delayed` job becomes runnable; null in every other state. */
    dueAt: z.iso.datetime().nullable(),
    startedAt: z.iso.datetime().nullable(),
    finishedAt: z.iso.datetime().nullable(),
    failedReason: z.string().min(1).max(500).nullable(),
  })
  .strict();

/**
 * The decision that produced this outbox row, plus the conversation summary
 * captured beside it. Null when the row predates `message_outbox_log` or the
 * stored jsonb no longer parses — the detail screen must still load.
 */
export const feedbackOutboxMessageLogSchema = z
  .object({
    origin: z.enum(MESSAGE_OUTBOX_LOG_ORIGINS),
    correlationId: z.string().min(1).max(200),
    decision: feedbackOutboundDecisionSchema,
    conversationState: outboundConversationSnapshotSchema,
    createdAt: z.iso.datetime(),
  })
  .strict();

/**
 * Everything durable about one outbox row, plus the one Redis lookup an opened
 * row is allowed to cost.
 *
 * There is no attempts table: `message_outbox` has no attempt counter and no
 * `message_outbox_attempts` exists. The provider ids below are the only durable
 * evidence that a send was ever tried — the deliver consumer writes them
 * before it can know the outcome, which is exactly why it reconciles against
 * them instead of retrying blindly.
 */
export const feedbackOutboxMessageDeliverySchema = z
  .object({
    id: z.uuid(),
    conversationId: z.uuid(),
    campaignId: z.uuid(),
    campaignStatus: z.enum(FEEDBACK_CAMPAIGN_STATUSES),
    kind: z.enum(MESSAGE_OUTBOX_KINDS),
    status: z.enum(MESSAGE_OUTBOX_STATUSES),
    deliveryStatus: z.enum(MESSAGE_OUTBOX_DELIVERY_STATUSES).nullable(),
    observedAt: z.iso.datetime(),
    waitingSeconds: z.number().int().nonnegative(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    deliveryUpdatedAt: z.iso.datetime().nullable(),
    sentAt: z.iso.datetime().nullable(),
    deliveredAt: z.iso.datetime().nullable(),
    readAt: z.iso.datetime().nullable(),
    playedAt: z.iso.datetime().nullable(),
    /** Present once a provider call was made, whatever its outcome. */
    providerLogId: z.string().min(1).max(200).nullable(),
    providerMessageId: z.string().min(1).max(200).nullable(),
    /**
     * When the relay reclaims a `sending` row whose job never reported back.
     * Null unless the row is `sending` — nothing else is on that clock.
     */
    reclaimAt: z.iso.datetime().nullable(),
    job: feedbackOutboxDeliverJobSchema,
    log: feedbackOutboxMessageLogSchema.nullable(),
  })
  .strict();

export const feedbackOutboxIdParamSchema = z
  .object({
    outboxId: z.uuid(),
  })
  .strict();

export class FeedbackOutboxQueueDto extends createZodDto(
  feedbackOutboxQueueSchema,
) {}
export class FeedbackOutboxHistoryDto extends createZodDto(
  feedbackOutboxHistorySchema,
) {}
export class FeedbackOutboxMessageDeliveryDto extends createZodDto(
  feedbackOutboxMessageDeliverySchema,
) {}
export class FeedbackOutboxIdParamDto extends createZodDto(
  feedbackOutboxIdParamSchema,
) {}

export type FeedbackOutboxQueueView = z.infer<typeof feedbackOutboxQueueSchema>;
export type FeedbackOutboxHistoryView = z.infer<
  typeof feedbackOutboxHistorySchema
>;
export type FeedbackOutboxHistoryItemView = z.infer<
  typeof feedbackOutboxHistoryItemSchema
>;
export type FeedbackOutboxQueueItemView = z.infer<
  typeof feedbackOutboxQueueItemSchema
>;
export type FeedbackOutboxMessageDeliveryView = z.infer<
  typeof feedbackOutboxMessageDeliverySchema
>;
