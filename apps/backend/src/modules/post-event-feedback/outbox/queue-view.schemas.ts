import {
  FEEDBACK_CAMPAIGN_STATUSES,
  MESSAGE_OUTBOX_DELIVERY_STATUSES,
  MESSAGE_OUTBOX_KINDS,
  MESSAGE_OUTBOX_LOG_ORIGINS,
  MESSAGE_OUTBOX_STATUSES,
} from "@slopform/database";
import { createZodDto } from "nestjs-zod";
import { z } from "zod";

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
     * The dispatcher claims nothing for a campaign that is not `launched`, so this
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
        claimed: z.number().int().nonnegative(),
        attempting: z.number().int().nonnegative(),
        ambiguous: z.number().int().nonnegative(),
        /** Rolling-deploy bridge for rows owned by the retired Bull consumer. */
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

/** Rows in one page of history when the caller does not say. */
export const FEEDBACK_OUTBOX_HISTORY_PAGE_SIZE = 25;

/**
 * Which slice of the log the caller wants.
 *
 * Every field is optional and the default is «the newest page of everything»,
 * so the screen's first paint needs no parameters at all. `from`/`to` are the
 * operator's own local day expressed as instants — this table is read as a log,
 * and «today» is a question about their clock, not the server's.
 */
export const feedbackOutboxHistoryQuerySchema = z
  .object({
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(FEEDBACK_OUTBOX_QUEUE_VIEW_LIMIT)
      .default(FEEDBACK_OUTBOX_HISTORY_PAGE_SIZE),
    /** Opaque; produced only by a previous response's `nextCursor`. */
    cursor: z.string().min(1).max(200).optional(),
    status: z.enum(MESSAGE_OUTBOX_STATUSES).optional(),
    from: z.iso.datetime().optional(),
    to: z.iso.datetime().optional(),
  })
  .strict();

export const feedbackOutboxHistorySchema = z
  .object({
    observedAt: z.iso.datetime(),
    /**
     * Rows matching the active filter — not rows in the table.
     *
     * Under a one-hour filter the table's own total would be a number about a
     * different set of rows, printed directly above the page it contradicts.
     */
    total: z.number().int().nonnegative(),
    /**
     * Where the next page begins, or null at the end of the log.
     *
     * This is the only pagination fact the client is given. There is no page
     * number and no page count on purpose: rows are appended while an operator
     * reads, so «page 3 of 40» would be stale before it finished rendering.
     */
    nextCursor: z.string().min(1).max(200).nullable(),
    items: z
      .array(feedbackOutboxHistoryItemSchema)
      .max(FEEDBACK_OUTBOX_QUEUE_VIEW_LIMIT),
  })
  .strict();

/** Durable dispatcher facts safe to expose to an operator. */
export const feedbackOutboxDispatchSchema = z
  .object({
    state: z.enum(MESSAGE_OUTBOX_STATUSES),
    /** Safe pre-send claims may be reclaimed after this instant. */
    claimExpiresAt: z.iso.datetime().nullable(),
    /** Durable no-return marker; null when no provider attempt is recorded. */
    sendStartedAt: z.iso.datetime().nullable(),
    attemptCount: z.number().int().nonnegative(),
    lastError: z.string().min(1).max(2_000).nullable(),
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
 * Everything durable about one outbox row. No queue lookup is involved: the
 * claim, no-return marker, attempt count and failure are PostgreSQL facts.
 */
export const feedbackOutboxMessageDeliverySchema = z
  .object({
    id: z.uuid(),
    conversationId: z.uuid(),
    campaignId: z.uuid(),
    campaignStatus: z.enum(FEEDBACK_CAMPAIGN_STATUSES),
    /**
     * Who this was written to, and the event it is about.
     *
     * Both lists carry these and the opened row did not, so the one pane in the
     * screen with room to say «this message, to this person, about this event»
     * was the one place that never said it — an operator who followed a link
     * into a row had to go back to the list to find out whose it was. The phone
     * is the launch-time number, the same one the lists showed; it moved here
     * when the list column narrowed, and this is where it can be acted on.
     */
    eventTitle: z.string().min(1).max(200),
    respondentDisplayName: z.string().min(1).max(200).nullable(),
    phoneAtLaunch: z.string().min(1).max(50).nullable(),
    kind: z.enum(MESSAGE_OUTBOX_KINDS),
    /**
     * The message itself, exactly as the participant receives it.
     *
     * The list answers «did it arrive»; this is the only place that answers
     * «what did we actually say to this person», which is the question a
     * complaint, a bad reply or a suspicious origin all end at. The bound is
     * the column's own `message_outbox_body_length_check`.
     *
     * It is not on the list rows and must not be: a page of 25 bodies is a
     * different endpoint's worth of payload for text nobody has asked to read
     * yet, and this pane is already the one place a row is opened deliberately.
     */
    body: z.string().min(1).max(10_000),
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
    dispatch: feedbackOutboxDispatchSchema,
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
export class FeedbackOutboxHistoryQueryDto extends createZodDto(
  feedbackOutboxHistoryQuerySchema,
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
export type FeedbackOutboxHistoryQuery = z.infer<
  typeof feedbackOutboxHistoryQuerySchema
>;
export type FeedbackOutboxQueueItemView = z.infer<
  typeof feedbackOutboxQueueItemSchema
>;
export type FeedbackOutboxMessageDeliveryView = z.infer<
  typeof feedbackOutboxMessageDeliverySchema
>;
