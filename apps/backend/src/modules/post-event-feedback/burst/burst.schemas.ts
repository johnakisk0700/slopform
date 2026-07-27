import { createZodDto } from "nestjs-zod";
import { z } from "zod";

import { FEEDBACK_ANSWER_QUESTION_KEYS } from "@join-the-six/database";

import { BURST_CAMPAIGN_SLUGS } from "./burst-scenario.js";

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
    ordinal: z.number().int().min(1).max(3),
    title: z.string().trim().min(1).max(200),
  })
  .strict();

export const feedbackBurstPersonaCatalogEntrySchema = z
  .object({
    id: z.string().trim().min(1).max(100),
    campaign: burstCampaignSlugSchema,
    ordinal: z.number().int().min(1).max(6),
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
    campaigns: z.array(feedbackBurstCampaignSchema).min(1),
    personas: z.array(feedbackBurstPersonaCatalogEntrySchema).length(18),
  })
  .strict();

export class FeedbackBurstCatalogResponseDto extends createZodDto(
  feedbackBurstCatalogResponseSchema,
) {}
