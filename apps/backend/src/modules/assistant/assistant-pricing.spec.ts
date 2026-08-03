import { describe, expect, it } from "vitest";

import {
  ASSISTANT_PRICING_VERSION,
  priceAssistantUsage,
} from "./assistant-pricing.js";

describe("priceAssistantUsage", () => {
  it("prices uncached and cached input separately and includes output reasoning", () => {
    expect(
      priceAssistantUsage("openai/gpt-5.6-luna", "standard", {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        reasoningTokens: 250_000,
        cachedInputTokens: 500_000,
        totalTokens: 2_000_000,
      }),
    ).toEqual({
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      reasoningTokens: 250_000,
      cachedInputTokens: 500_000,
      totalTokens: 2_000_000,
      estimatedCostEurMicros: 1_150_233,
      pricingVersion: ASSISTANT_PRICING_VERSION,
    });
  });

  it("applies the OpenAI fast-lane multiplier", () => {
    const standard = priceAssistantUsage("openai/gpt-5.6-terra", "standard", {
      inputTokens: 10_000,
      outputTokens: 1_000,
      reasoningTokens: 400,
      cachedInputTokens: 0,
      totalTokens: 11_000,
    });
    const fast = priceAssistantUsage("openai/gpt-5.6-terra", "fast", {
      inputTokens: 10_000,
      outputTokens: 1_000,
      reasoningTokens: 400,
      cachedInputTokens: 0,
      totalTokens: 11_000,
    });

    expect(
      Math.abs(
        (fast.estimatedCostEurMicros ?? 0) -
          (standard.estimatedCostEurMicros ?? 0) * 2,
      ),
    ).toBeLessThanOrEqual(1);
  });

  it("keeps usage but declines to invent a cost when token totals are missing", () => {
    expect(
      priceAssistantUsage("google/gemini-3.6-flash", "standard", {
        inputTokens: null,
        outputTokens: 10,
        reasoningTokens: null,
        cachedInputTokens: null,
        totalTokens: null,
      }),
    ).toMatchObject({
      estimatedCostEurMicros: null,
      pricingVersion: null,
    });
  });
});
