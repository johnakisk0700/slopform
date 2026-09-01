import type { MessageOutboxLogOrigin } from "@slopform/database";
import { z } from "zod";

/**
 * Why an outbox row was written. Origins must stay equal to
 * `MESSAGE_OUTBOX_LOG_ORIGINS`; stringly goal statuses are intentional — the
 * log is a tolerant audit record and must survive enum drift in extraction.
 */
export const feedbackOutboundDecisionSchema = z.discriminatedUnion("origin", [
  z
    .object({
      origin: z.literal("extraction_reply"),
      model: z.string().min(1),
      confidence: z.number().min(0).max(1).nullable(),
      closingReason: z.enum(["completed", "declined"]).nullable(),
      askedGoal: z.string().nullable(),
      /**
       * Venue context used by this model run. Null means the prompt was venue
       * blind; optional keeps historical log rows readable.
       */
      venueContextRevision: z.number().int().min(1).nullable().optional(),
      goalStatuses: z.array(
        z.object({
          key: z.string().min(1),
          status: z.string().min(1),
        }),
      ),
    })
    .strict(),
  z
    .object({
      origin: z.literal("extraction_fallback_fence"),
      cause: z.string().min(1),
    })
    .strict(),
  z
    .object({
      origin: z.literal("extraction_fallback_ack"),
      cause: z.string().min(1),
    })
    .strict(),
  z
    .object({
      origin: z.literal("extraction_parked_notice"),
      cause: z.string().min(1),
    })
    .strict(),
  z
    .object({
      origin: z.literal("stop_ack"),
      sourceIngressId: z.uuid(),
    })
    .strict(),
  z
    .object({
      origin: z.literal("media_notice"),
      sourceIngressId: z.uuid(),
    })
    .strict(),
  z
    .object({
      origin: z.literal("staff_message"),
      staffActorId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      origin: z.literal("campaign_intro"),
      conversationCreated: z.boolean(),
    })
    .strict(),
  z
    .object({
      origin: z.literal("reminder"),
      rung: z.number().int().min(1),
    })
    .strict(),
]);

export type FeedbackOutboundDecision = z.infer<
  typeof feedbackOutboundDecisionSchema
>;

type AssertOriginParity<T extends MessageOutboxLogOrigin> =
  MessageOutboxLogOrigin extends T ? true : never;
const _originParity: AssertOriginParity<FeedbackOutboundDecision["origin"]> =
  true;
void _originParity;
