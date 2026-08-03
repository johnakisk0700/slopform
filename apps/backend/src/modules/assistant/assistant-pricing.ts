import type {
  AssistantModel,
  AssistantServiceTier,
  AssistantUsage,
} from "./assistant.schemas.js";

/**
 * Dated on purpose. This is an operator estimate, not an invoice, and making a
 * completed turn depend on live FX or pricing endpoints would be an impressive
 * way to turn a decorative badge into an outage source.
 */
export const ASSISTANT_PRICING_VERSION = "2026-08-03";
const EUR_PER_USD = 1 / 1.1389;

interface TokenRates {
  readonly inputUsdPerMillion: number;
  readonly cachedInputUsdPerMillion: number;
  readonly outputUsdPerMillion: number;
}

const STANDARD_RATES: Readonly<Record<AssistantModel, TokenRates>> = {
  "openai/gpt-5.6-luna": {
    inputUsdPerMillion: 0.2,
    cachedInputUsdPerMillion: 0.02,
    outputUsdPerMillion: 1.2,
  },
  "openai/gpt-5.6-terra": {
    inputUsdPerMillion: 2,
    cachedInputUsdPerMillion: 0.2,
    outputUsdPerMillion: 12,
  },
  "google/gemini-3.6-flash": {
    inputUsdPerMillion: 1.5,
    cachedInputUsdPerMillion: 0.15,
    outputUsdPerMillion: 7.5,
  },
  "qwen/qwen3.7-max": {
    inputUsdPerMillion: 1.475,
    // No stable cache-read rate is published for the route. Charging cached
    // input at list input price avoids manufacturing a discount.
    cachedInputUsdPerMillion: 1.475,
    outputUsdPerMillion: 4.425,
  },
};

export interface AssistantRawUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly reasoningTokens: number | null;
  readonly cachedInputTokens: number | null;
  readonly totalTokens: number | null;
}

export function priceAssistantUsage(
  model: AssistantModel,
  serviceTier: AssistantServiceTier,
  usage: AssistantRawUsage,
): AssistantUsage {
  const rates = STANDARD_RATES[model];
  const tierMultiplier =
    serviceTier === "fast" && model.startsWith("openai/") ? 2 : 1;
  const inputTokens = usage.inputTokens;
  const outputTokens = usage.outputTokens;

  let estimatedCostEurMicros: number | null = null;
  if (inputTokens !== null && outputTokens !== null) {
    const cachedInputTokens = Math.min(
      inputTokens,
      Math.max(0, usage.cachedInputTokens ?? 0),
    );
    const uncachedInputTokens = inputTokens - cachedInputTokens;
    // USD-per-million times tokens, converted to EUR, is numerically equal to
    // euro-micros. Keeping the integer avoids a floating-point currency field.
    estimatedCostEurMicros = Math.round(
      EUR_PER_USD *
        tierMultiplier *
        (uncachedInputTokens * rates.inputUsdPerMillion +
          cachedInputTokens * rates.cachedInputUsdPerMillion +
          outputTokens * rates.outputUsdPerMillion),
    );
  }

  return {
    ...usage,
    estimatedCostEurMicros,
    pricingVersion:
      estimatedCostEurMicros === null ? null : ASSISTANT_PRICING_VERSION,
  };
}
