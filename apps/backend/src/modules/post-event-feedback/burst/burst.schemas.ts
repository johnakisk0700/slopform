import { createZodDto } from "nestjs-zod";
import { z } from "zod";

import { FEEDBACK_ANSWER_QUESTION_KEYS } from "@slopform/database";

import { eventVenueInputSchema } from "../../events/events.schemas.js";
import { FEEDBACK_OBSERVED_TEXT_HARD_LIMIT } from "../jobs.schemas.js";
import {
  FEEDBACK_CONVERSATION_LIFECYCLE_REASONS,
  feedbackConversationExtractionUsageSchema,
} from "../post-event-feedback-conversation.document.js";
import { BURST_PERSONAS } from "./burst-personas.js";
import {
  BURST_CAMPAIGNS,
  BURST_CAMPAIGN_SLUGS,
  BURST_PERSONAS_PER_CAMPAIGN,
} from "./burst-scenario.js";

const burstCampaignSlugSchema = z.enum(BURST_CAMPAIGN_SLUGS);

const burstExpectedAnswerSchema = z
  .object({
    question: z.enum(FEEDBACK_ANSWER_QUESTION_KEYS),
    about: z.string().trim().min(1).max(200).nullable(),
    value: z.number().int().nullable(),
  })
  .strict();

const burstExpectedOutcomeSchema = z
  .object({
    lifecycle: z.enum(["open", "closed"]),
    closedBecause: z.enum(FEEDBACK_CONVERSATION_LIFECYCLE_REASONS).nullable(),
    optedIn: z.boolean(),
    answers: z.array(burstExpectedAnswerSchema),
    needsAttention: z.boolean(),
    minReceived: z.number().int().min(0),
    maxReceived: z.number().int().min(0),
  })
  .strict();

const burstPersonaMessageSchema = z
  .object({
    afterMs: z.number().int().min(0),
    /**
     * Bounded by what an inbound may durably *hold*, not by what we are allowed
     * to send. Those are different numbers on purpose
     * (`FEEDBACK_OBSERVED_TEXT_HARD_LIMIT` against the 4 096-character send
     * limit), and a persona exists specifically to drive a message into the gap
     * between them. `null` is a voice note or a photo — an inbound with no body.
     */
    text: z.string().min(1).max(FEEDBACK_OBSERVED_TEXT_HARD_LIMIT).nullable(),
  })
  .strict();

export const feedbackBurstCampaignSchema = z
  .object({
    slug: burstCampaignSlugSchema,
    ordinal: z.number().int().min(1).max(BURST_CAMPAIGNS.length),
    title: z.string().trim().min(1).max(200),
    venue: eventVenueInputSchema,
  })
  .strict();

export const feedbackBurstPersonaCatalogEntrySchema = z
  .object({
    id: z.string().trim().min(1).max(100),
    campaign: burstCampaignSlugSchema,
    ordinal: z.number().int().min(1).max(BURST_PERSONAS_PER_CAMPAIGN),
    displayName: z.string().trim().min(1).max(200),
    phoneE164: z
      .string()
      .regex(/^\+[1-9]\d{7,14}$/u, "Expected an E.164 phone number"),
    quirk: z.string().trim().min(1).max(500),
    mirrors: z.string().trim().min(1).max(100),
    messages: z.array(burstPersonaMessageSchema),
    /** The model that improvises this guest's replies, for a live guest only. */
    liveModel: z.string().trim().min(1).max(100).optional(),
    expect: burstExpectedOutcomeSchema,
  })
  .strict()
  .superRefine((persona, context) => {
    // A scripted persona with no messages sends nothing and would sit in the
    // rehearsal as a silent seat nobody notices — which is why this used to be
    // `min(1)`. A live guest genuinely has no script: its messages do not exist
    // until the bot has spoken. So the bound moves from "at least one message"
    // to "at least one message unless somebody is writing them at run time",
    // which is the invariant that was actually meant.
    if (persona.messages.length === 0 && !persona.liveModel) {
      context.addIssue({
        code: "custom",
        message:
          "A persona with no messages must name the model improvising it",
      });
    }
  });

export const feedbackBurstCatalogResponseSchema = z
  .object({
    /**
     * Whether this API process constructed the deterministic extraction stub.
     * The burst runner refuses a free rehearsal unless this is true — checking
     * only the caller's env would miss a worker that was started without the
     * stub and quietly billed a provider.
     */
    extractionStub: z.boolean(),
    /** True when at least one BullMQ worker is registered on the feedback queue. */
    workerRegistered: z.boolean(),
    campaigns: z.array(feedbackBurstCampaignSchema).min(1),
    /**
     * Bounded by the catalogue rather than by a number typed here.
     *
     * This was `.length(18)`, and a fourth dinner turned the whole endpoint
     * into a 500 that no test could see: every unit test builds its own
     * catalogue, so nothing ever parsed the real one. The runner reads this
     * endpoint before it does anything, so the failure surfaced as the
     * rehearsal refusing to start.
     */
    // The catalogue's own length, not campaigns times table size. Those two
    // agreed only while every dinner was full: the live-guest table seats two,
    // and computing the bound from a table size that no longer describes every
    // campaign is how a correct catalogue starts failing its own schema.
    personas: z
      .array(feedbackBurstPersonaCatalogEntrySchema)
      .min(1)
      .max(BURST_PERSONAS.length),
  })
  .strict();

export const feedbackBurstAccountingQuerySchema = z
  .object({
    campaignId: z.preprocess(
      (value) => (Array.isArray(value) ? value : [value]),
      z.array(z.uuid()).min(1).max(BURST_CAMPAIGNS.length),
    ),
  })
  .strict();

export const feedbackBurstAccountingResponseSchema = z.array(
  z
    .object({
      conversationId: z.uuid(),
      extraction: z
        .object({
          model: z.string().trim().min(1).max(200).nullable(),
          usage: feedbackConversationExtractionUsageSchema.nullable(),
          serviceTier: z.string().trim().min(1).max(50).nullable(),
        })
        .strict(),
    })
    .strict(),
);

export class FeedbackBurstCatalogResponseDto extends createZodDto(
  feedbackBurstCatalogResponseSchema,
) {}

export class FeedbackBurstAccountingQueryDto extends createZodDto(
  feedbackBurstAccountingQuerySchema,
) {}

export class FeedbackBurstAccountingResponseDto extends createZodDto(
  feedbackBurstAccountingResponseSchema,
) {}
