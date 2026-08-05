import { z } from "zod";

import type { FeedbackCampaignSummaryMetrics } from "./summary-metrics.js";

export const FEEDBACK_CAMPAIGN_SUMMARY_DOCUMENT_VERSION = 4 as const;

/**
 * Hard ceilings per narrative list — not a shared pool. Gossip and wentWrong
 * get the room; the rest stay short so the model spends colour on the tea.
 */
export const FEEDBACK_SUMMARY_LIST_ITEM_MAX = {
  gossip: 10,
  wentWrong: 10,
  wentWell: 5,
  curiosities: 5,
  actions: 5,
} as const;

/** How loud a well/wrong line should read on the accordion. */
export const FEEDBACK_SUMMARY_FINDING_WEIGHTS = [
  "low",
  "medium",
  "high",
] as const;

export type FeedbackSummaryFindingWeight =
  (typeof FEEDBACK_SUMMARY_FINDING_WEIGHTS)[number];

const listItemSchema = z.string().trim().min(1).max(280);

export const feedbackSummaryFindingItemSchema = z
  .object({
    text: listItemSchema,
    weight: z.enum(FEEDBACK_SUMMARY_FINDING_WEIGHTS).describe(
      "How loud this line should read: low = quiet aside, medium = normal callout, high = punchy — reserve high for clear wins (wentWell) or real harm / sharp complaints (wentWrong). Prefer medium; do not mark every line high.",
    ),
  })
  .strict();

export type FeedbackSummaryFindingItem = z.infer<
  typeof feedbackSummaryFindingItemSchema
>;

/** What the model is asked to fill. Metrics stay out — they are counted. */
export const feedbackCampaignSummaryNarrativeSchema = z
  .object({
    curiosities: z
      .array(listItemSchema)
      .max(FEEDBACK_SUMMARY_LIST_ITEM_MAX.curiosities)
      .describe(
        "Αξιοπερίεργα: up to 5 odd patterns not already in wentWell/wentWrong/gossip — surprising skews, single-voice quirks. Keep short; spend colour on gossip. Empty when nothing stands. Do not pad.",
      ),
    gossip: z
      .array(listItemSchema)
      .max(FEEDBACK_SUMMARY_LIST_ITEM_MAX.gossip)
      .describe(
        "Κουτσομπολιό: up to 10 juicy social-tea lines in stand-up observational voice — who clicked with whom, table chemistry, spicy-but-harmless quotes and the night's silly drama, grounded in evidence. Never put racism, abuse, or conduct flags here (those stay in wentWrong). Empty only when there is truly no tea. Do not pad.",
      ),
    actions: z
      .array(listItemSchema)
      .max(FEEDBACK_SUMMARY_LIST_ITEM_MAX.actions)
      .describe(
        "Up to 5 concrete actions for the next dinner. Empty when the data does not support an action — do not invent work. Prefer fewer sharp items over a long list.",
      ),
    wentWell: z
      .array(feedbackSummaryFindingItemSchema)
      .max(FEEDBACK_SUMMARY_LIST_ITEM_MAX.wentWell)
      .describe(
        "Up to 5 brief findings on what went well (high scores, praise, meet-again). Each item is `{ text, weight }` with weight low|medium|high. Keep text terse — gossip owns the colourful budget. high only for standout wins with clear evidence; default medium. Empty when nothing supports a claim. Do not pad.",
      ),
    wentWrong: z
      .array(feedbackSummaryFindingItemSchema)
      .max(FEEDBACK_SUMMARY_LIST_ITEM_MAX.wentWrong)
      .describe(
        "Up to 10 everyday Greek findings on what went wrong — collect distinct situations: low scores, complaints, flagged notes, unresolved attention. Each item is `{ text, weight }` with weight low|medium|high. high for racism, abuse, or sharp multi-voice harm; medium for ordinary complaints; low for mild / single-voice asides. A bare avoid with no harm evidence stays a no-rematch preference at low or medium. Prefer completeness over brevity when situations differ. Empty when nothing supports a claim. Do not pad.",
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
    curiosities: z
      .array(listItemSchema)
      .max(FEEDBACK_SUMMARY_LIST_ITEM_MAX.curiosities),
    gossip: z.array(listItemSchema).max(FEEDBACK_SUMMARY_LIST_ITEM_MAX.gossip),
    actions: z
      .array(listItemSchema)
      .max(FEEDBACK_SUMMARY_LIST_ITEM_MAX.actions),
    wentWell: z
      .array(feedbackSummaryFindingItemSchema)
      .max(FEEDBACK_SUMMARY_LIST_ITEM_MAX.wentWell),
    wentWrong: z
      .array(feedbackSummaryFindingItemSchema)
      .max(FEEDBACK_SUMMARY_LIST_ITEM_MAX.wentWrong),
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

/** Plain-string findings before weight — projected to medium on read. */
const feedbackCampaignSummaryDocumentV3Schema = z
  .object({
    version: z.literal(3),
    metrics: feedbackCampaignSummaryMetricsSchema,
    curiosities: z
      .array(listItemSchema)
      .max(FEEDBACK_SUMMARY_LIST_ITEM_MAX.curiosities),
    gossip: z.array(listItemSchema).max(FEEDBACK_SUMMARY_LIST_ITEM_MAX.gossip),
    actions: z
      .array(listItemSchema)
      .max(FEEDBACK_SUMMARY_LIST_ITEM_MAX.actions),
    wentWell: z
      .array(listItemSchema)
      .max(FEEDBACK_SUMMARY_LIST_ITEM_MAX.wentWell),
    wentWrong: z
      .array(listItemSchema)
      .max(FEEDBACK_SUMMARY_LIST_ITEM_MAX.wentWrong),
    missing: z.string().trim().min(1).max(280).nullable(),
  })
  .strict();

function asMediumFindings(
  lines: readonly string[],
): FeedbackSummaryFindingItem[] {
  return lines.map((text) => ({ text, weight: "medium" as const }));
}

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
 * Structured v4 bodies parse; v3 plain-string findings and v2 `highlights`
 * project forward so an already-generated row still renders until refresh.
 * Legacy markdown returns null for the old renderer.
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
    const v3 = feedbackCampaignSummaryDocumentV3Schema.safeParse(raw);
    if (v3.success) {
      return feedbackCampaignSummaryDocumentSchema.parse({
        version: FEEDBACK_CAMPAIGN_SUMMARY_DOCUMENT_VERSION,
        metrics: v3.data.metrics,
        curiosities: v3.data.curiosities,
        gossip: v3.data.gossip,
        actions: v3.data.actions,
        wentWell: asMediumFindings(v3.data.wentWell),
        wentWrong: asMediumFindings(v3.data.wentWrong),
        missing: v3.data.missing,
      });
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
      wentWell: asMediumFindings(legacy.data.wentWell),
      wentWrong: asMediumFindings(legacy.data.wentWrong),
      missing: legacy.data.missing,
    });
  } catch {
    return null;
  }
}
