import { createZodDto } from "nestjs-zod";
import { z } from "zod";

import { FEEDBACK_ANSWER_QUESTION_KEYS } from "@join-the-six/database";

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
    closedBecause: z
      .enum(["completed", "stopped", "expired", "cancelled"])
      .nullable(),
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
    text: z.string().min(1),
  })
  .strict();

export const feedbackBurstCampaignSchema = z
  .object({
    slug: burstCampaignSlugSchema,
    ordinal: z.number().int().min(1).max(BURST_CAMPAIGNS.length),
    title: z.string().trim().min(1).max(200),
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
    messages: z.array(burstPersonaMessageSchema).min(1),
    expect: burstExpectedOutcomeSchema,
  })
  .strict();

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
    personas: z
      .array(feedbackBurstPersonaCatalogEntrySchema)
      .min(1)
      .max(BURST_CAMPAIGNS.length * BURST_PERSONAS_PER_CAMPAIGN),
  })
  .strict();

export class FeedbackBurstCatalogResponseDto extends createZodDto(
  feedbackBurstCatalogResponseSchema,
) {}
