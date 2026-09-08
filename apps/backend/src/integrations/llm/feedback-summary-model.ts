import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createOpenAI } from "@ai-sdk/openai";
import { generateObject, type LanguageModel } from "ai";

import type { Environment } from "../../infrastructure/config/environment.js";
import {
  assistantModelSchema,
  type AssistantModel,
} from "../../modules/assistant/assistant.schemas.js";
import { feedbackCampaignSummaryNarrativeSchema } from "../../modules/post-event-feedback/summary/summary-document.js";
import { assistantModelAdapter } from "./assistant-models.js";
import { ProviderCallLimiter } from "./provider-call-limiter.js";

export const DEFAULT_FEEDBACK_SUMMARY_MODEL =
  "openai/gpt-5.6-terra" as const satisfies AssistantModel;

export const DEFAULT_FEEDBACK_SUMMARY_REASONING_EFFORT = "high" as const;

export const FEEDBACK_SUMMARY_REASONING_EFFORTS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type FeedbackSummaryReasoningEffort =
  (typeof FEEDBACK_SUMMARY_REASONING_EFFORTS)[number];

/**
 * What a summary narrative needs when the model is not spending the budget on
 * thinking. Kept as the non-thinking floor; production always selects an
 * effort from {@link FEEDBACK_SUMMARY_REASONING_EFFORTS}, so the live call uses
 * {@link FEEDBACK_SUMMARY_THINKING_MAX_OUTPUT_TOKENS}.
 */
export const FEEDBACK_SUMMARY_MAX_OUTPUT_TOKENS = 4_096;

/**
 * Ceiling once Terra is allowed to think. Reasoning tokens come out of the
 * same `maxOutputTokens` budget as the JSON object — the extraction path
 * measured that `xhigh` on a 2,048 ceiling spent the entire budget thinking
 * and returned `NoObjectGeneratedError` with no object. Summary defaults to
 * `high` (and production has used `xhigh`); a flat 4,096 ceiling is the same
 * trap on a harder prompt. Keep this far above extraction's 16,384: Terra at
 * high/xhigh on a full campaign digests more evidence and thinks longer. A
 * ceiling is not a charge — it only has to leave room for the narrative after
 * the thinking.
 */
export const FEEDBACK_SUMMARY_THINKING_MAX_OUTPUT_TOKENS = 65_536;

/** Summary has no `none` effort; every configured value pays for thinking. */
export function feedbackSummaryMaxOutputTokens(
  _effort: FeedbackSummaryReasoningEffort,
): number {
  return FEEDBACK_SUMMARY_THINKING_MAX_OUTPUT_TOKENS;
}

export const FEEDBACK_SUMMARY_TIMEOUT_MILLISECONDS = 300_000;
export class FeedbackSummaryGenerationError extends Error {
  constructor(
    readonly retryable: boolean,
    readonly detail: string = "",
  ) {
    super("Feedback campaign summary generation failed");
    this.name = FeedbackSummaryGenerationError.name;
  }
}

/** Provider setup and generation; the caller owns the campaign execution claim. */
@Injectable()
export class FeedbackCampaignSummaryModel {
  private readonly openAiProvider: ReturnType<typeof createOpenAI> | undefined;
  readonly model: AssistantModel;
  readonly reasoningEffort: FeedbackSummaryReasoningEffort;

  constructor(
    config: ConfigService<Environment, true>,
    private readonly providerCalls: ProviderCallLimiter = new ProviderCallLimiter(),
  ) {
    const openAiKey = config.get("OPENAI_API_KEY", { infer: true });
    this.openAiProvider = openAiKey
      ? createOpenAI({ apiKey: openAiKey })
      : undefined;
    this.model = resolveFeedbackSummaryModel(
      config.get("FEEDBACK_SUMMARY_MODEL", { infer: true }),
    );
    this.reasoningEffort = resolveFeedbackSummaryReasoningEffort(
      config.get("FEEDBACK_SUMMARY_REASONING_EFFORT", { infer: true }),
    );
  }

  async generate(prompt: string, beforeProviderCall: () => Promise<void>) {
    const model = this.resolveProviderModel();
    const result = await this.providerCalls.run(async () => {
      await beforeProviderCall();
      return generateObject({
        model,
        schema: feedbackCampaignSummaryNarrativeSchema,
        schemaName: "feedback_campaign_summary_narrative",
        schemaDescription:
          "Short Greek operator lists for a post-event feedback campaign summary. Metrics are counted separately and must not be restated here.",
        messages: [{ role: "user", content: prompt }],
        maxOutputTokens: feedbackSummaryMaxOutputTokens(this.reasoningEffort),
        maxRetries: 0,
        abortSignal: AbortSignal.timeout(FEEDBACK_SUMMARY_TIMEOUT_MILLISECONDS),
        providerOptions: {
          openai: { reasoningEffort: this.reasoningEffort },
        },
      });
    });
    return feedbackCampaignSummaryNarrativeSchema.parse(result.object);
  }

  private resolveProviderModel(): LanguageModel {
    const adapter = assistantModelAdapter(this.model);
    if (adapter.provider !== "openai") {
      throw new FeedbackSummaryGenerationError(
        false,
        "summary_requires_openai_direct",
      );
    }
    if (!this.openAiProvider) {
      throw new FeedbackSummaryGenerationError(false, "missing_openai_key");
    }
    return this.openAiProvider(adapter.providerModelId);
  }
}

export function resolveFeedbackSummaryModel(
  configured: string | undefined,
): AssistantModel {
  const candidate = configured?.trim() || DEFAULT_FEEDBACK_SUMMARY_MODEL;
  const parsed = assistantModelSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new Error(`Unknown FEEDBACK_SUMMARY_MODEL: ${candidate}`);
  }
  if (assistantModelAdapter(parsed.data).provider !== "openai") {
    throw new Error(
      `FEEDBACK_SUMMARY_MODEL must route OpenAI direct: ${candidate}`,
    );
  }
  return parsed.data;
}

export function resolveFeedbackSummaryReasoningEffort(
  configured: string | undefined,
): FeedbackSummaryReasoningEffort {
  const candidate =
    configured?.trim() || DEFAULT_FEEDBACK_SUMMARY_REASONING_EFFORT;
  if (
    !(FEEDBACK_SUMMARY_REASONING_EFFORTS as readonly string[]).includes(
      candidate,
    )
  ) {
    throw new Error(`Unknown FEEDBACK_SUMMARY_REASONING_EFFORT: ${candidate}`);
  }
  return candidate as FeedbackSummaryReasoningEffort;
}
