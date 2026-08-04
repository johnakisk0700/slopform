import { z } from "zod";

import type { FeedbackCampaignSummaryMetrics } from "./summary-metrics.js";

export const FEEDBACK_CAMPAIGN_SUMMARY_DOCUMENT_VERSION = 3 as const;

/**
 * Hard ceiling per narrative list. Room for a messy night (~10); beyond that
 * the accordion stops being scannable and the model is padding.
 */
const LIST_ITEM_MAX = 10;

const listItemSchema = z.string().trim().min(1).max(280);

/** What the model is asked to fill. Metrics stay out — they are counted. */
export const feedbackCampaignSummaryNarrativeSchema = z
  .object({
    curiosities: z
      .array(listItemSchema)
      .max(LIST_ITEM_MAX)
      .describe(
        "Αξιοπερίεργα: up to 10 odd or notable patterns not already in wentWell/wentWrong — surprising skews, single-voice remarks worth keeping (labelled as one voice), funny-but-not-harmful quirks. Prefer collecting distinct items that stand; empty when nothing stands. Do not pad.",
      ),
    gossip: z
      .array(listItemSchema)
      .max(LIST_ITEM_MAX)
      .describe(
        "Κουτσομπολιό: up to 10 social-tea lines — who people named in a chatty way, table chemistry, spicy-but-not-harmful quotes. Prefer collecting distinct juicy items when the evidence has them. Never put racism, abuse, or conduct flags here (those stay in wentWrong). Empty when nothing juicy. Do not pad.",
      ),
    actions: z
      .array(listItemSchema)
      .max(LIST_ITEM_MAX)
      .describe(
        "Up to 10 concrete actions for the next dinner: seating, follow-up on a stated interest, who wants to see whom again. Empty when the data does not support an action — do not invent work.",
      ),
    wentWell: z
      .array(listItemSchema)
      .max(LIST_ITEM_MAX)
      .describe(
        "Up to 10 brief lines on what went well, grounded in high scores, praise in notes, and meet-again intent. Prefer collecting distinct positives when they stand. Empty when nothing supports a claim. Do not pad.",
      ),
    wentWrong: z
      .array(listItemSchema)
      .max(LIST_ITEM_MAX)
      .describe(
        "Up to 10 everyday Greek lines on what went wrong — collect distinct situations: low scores, complaints, flagged notes, unresolved attention. When evidence shows racism or abuse of another guest, name it plainly and keep it here. A bare avoid with no such evidence stays a no-rematch preference. Prefer completeness over brevity when situations differ. Empty when nothing supports a claim. Do not pad.",
      ),
    missing: z
      .string()
      .trim()
      .min(1)
      .max(280)
      .nullable()
      .describe(
        "One line on what is still missing when the campaign is partial or a signal rests on very few answers. Null when nothing is missing.",
      ),
  })
  .strict();

export type FeedbackCampaignSummaryNarrative = z.infer<
  typeof feedbackCampaignSummaryNarrativeSchema
>;

const scoreMetricSchema = z
  .object({
    questionKey: z.string().min(1).max(80),
    label: z.string().min(1).max(200),
    answerCount: z.number().int().nonnegative(),
    average: z.number().nullable(),
    max: z.number().int().positive(),
    distribution: z
      .array(
        z
          .object({
            value: z.number().int(),
            count: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .max(10),
  })
  .strict();

const directedMetricSchema = z
  .object({
    questionKey: z.string().min(1).max(80),
    label: z.string().min(1).max(200),
    edgeCount: z.number().int().nonnegative(),
    respondentCount: z.number().int().nonnegative(),
  })
  .strict();

export const feedbackCampaignSummaryMetricsSchema = z
  .object({
    questionSetVersion: z.union([z.literal(1), z.literal(2)]),
    scores: z.array(scoreMetricSchema).max(8),
    directed: z.array(directedMetricSchema).max(8),
  })
  .strict();

export const feedbackCampaignSummaryDocumentSchema = z
  .object({
    version: z.literal(FEEDBACK_CAMPAIGN_SUMMARY_DOCUMENT_VERSION),
    metrics: feedbackCampaignSummaryMetricsSchema,
    curiosities: z.array(listItemSchema).max(LIST_ITEM_MAX),
    gossip: z.array(listItemSchema).max(LIST_ITEM_MAX),
    actions: z.array(listItemSchema).max(LIST_ITEM_MAX),
    wentWell: z.array(listItemSchema).max(LIST_ITEM_MAX),
    wentWrong: z.array(listItemSchema).max(LIST_ITEM_MAX),
    missing: z.string().trim().min(1).max(280).nullable(),
  })
  .strict();

export type FeedbackCampaignSummaryDocument = z.infer<
  typeof feedbackCampaignSummaryDocumentSchema
>;

/** Stored before gossip/curiosities split — projected forward on read. */
const feedbackCampaignSummaryDocumentV2Schema = z
  .object({
    version: z.literal(2),
    metrics: feedbackCampaignSummaryMetricsSchema,
    highlights: z.array(listItemSchema).max(3),
    actions: z.array(listItemSchema).max(3),
    wentWell: z.array(listItemSchema).max(3),
    wentWrong: z.array(listItemSchema).max(3),
    missing: z.string().trim().min(1).max(280).nullable(),
  })
  .strict();

export function buildFeedbackCampaignSummaryDocument(input: {
  readonly metrics: FeedbackCampaignSummaryMetrics;
  readonly narrative: FeedbackCampaignSummaryNarrative;
}): FeedbackCampaignSummaryDocument {
  return feedbackCampaignSummaryDocumentSchema.parse({
    version: FEEDBACK_CAMPAIGN_SUMMARY_DOCUMENT_VERSION,
    metrics: input.metrics,
    curiosities: input.narrative.curiosities,
    gossip: input.narrative.gossip,
    actions: input.narrative.actions,
    wentWell: input.narrative.wentWell,
    wentWrong: input.narrative.wentWrong,
    missing: input.narrative.missing,
  });
}

export function serializeFeedbackCampaignSummaryDocument(
  document: FeedbackCampaignSummaryDocument,
): string {
  return JSON.stringify(document);
}

/**
 * Structured v3 bodies parse; v2 bodies with `highlights` project into
 * curiosities (gossip empty) so an already-generated row still renders until
 * refresh. Legacy markdown returns null for the old renderer.
 */
export function parseFeedbackCampaignSummaryDocument(
  body: string | null | undefined,
): FeedbackCampaignSummaryDocument | null {
  if (!body) {
    return null;
  }
  const trimmed = body.trim();
  if (!trimmed.startsWith("{")) {
    return null;
  }
  try {
    const raw: unknown = JSON.parse(trimmed);
    const current = feedbackCampaignSummaryDocumentSchema.safeParse(raw);
    if (current.success) {
      return current.data;
    }
    const legacy = feedbackCampaignSummaryDocumentV2Schema.safeParse(raw);
    if (!legacy.success) {
      return null;
    }
    return feedbackCampaignSummaryDocumentSchema.parse({
      version: FEEDBACK_CAMPAIGN_SUMMARY_DOCUMENT_VERSION,
      metrics: legacy.data.metrics,
      curiosities: legacy.data.highlights,
      gossip: [],
      actions: legacy.data.actions,
      wentWell: legacy.data.wentWell,
      wentWrong: legacy.data.wentWrong,
      missing: legacy.data.missing,
    });
  } catch {
    return null;
  }
}
