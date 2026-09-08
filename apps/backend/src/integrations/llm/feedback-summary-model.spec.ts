import type { ConfigService } from "@nestjs/config";
import { generateObject } from "ai";
import { setImmediate } from "node:timers/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Environment } from "../../infrastructure/config/environment.js";
import { ProviderCallLimiter } from "./provider-call-limiter.js";
import {
  DEFAULT_FEEDBACK_SUMMARY_MODEL,
  DEFAULT_FEEDBACK_SUMMARY_REASONING_EFFORT,
  FEEDBACK_SUMMARY_MAX_OUTPUT_TOKENS,
  FEEDBACK_SUMMARY_THINKING_MAX_OUTPUT_TOKENS,
  FeedbackCampaignSummaryModel,
  feedbackSummaryMaxOutputTokens,
  resolveFeedbackSummaryModel,
  resolveFeedbackSummaryReasoningEffort,
} from "./feedback-summary-model.js";

vi.mock("ai", async (importOriginal) => {
  const original = await importOriginal<typeof import("ai")>();
  return { ...original, generateObject: vi.fn() };
});

describe("feedback summary configuration", () => {
  it("reserves Terra high as the explicit summary default", () => {
    expect(DEFAULT_FEEDBACK_SUMMARY_MODEL).toBe("openai/gpt-5.6-terra");
    expect(DEFAULT_FEEDBACK_SUMMARY_REASONING_EFFORT).toBe("high");
  });

  it.each([undefined, "", "   "])(
    "uses documented defaults for an absent or blank value (%s)",
    (configured) => {
      expect(resolveFeedbackSummaryModel(configured)).toBe(
        DEFAULT_FEEDBACK_SUMMARY_MODEL,
      );
      expect(resolveFeedbackSummaryReasoningEffort(configured)).toBe(
        DEFAULT_FEEDBACK_SUMMARY_REASONING_EFFORT,
      );
    },
  );

  // Same measured trap as extraction: reasoning tokens share maxOutputTokens
  // with the JSON object. A flat 4,096 ceiling on Terra high/xhigh can spend
  // the whole budget thinking and surface as NoObjectGeneratedError.
  it("raises the output ceiling for every configured summary effort", () => {
    for (const effort of ["low", "medium", "high", "xhigh", "max"] as const) {
      expect(feedbackSummaryMaxOutputTokens(effort), effort).toBe(
        FEEDBACK_SUMMARY_THINKING_MAX_OUTPUT_TOKENS,
      );
    }
    expect(FEEDBACK_SUMMARY_THINKING_MAX_OUTPUT_TOKENS).toBeGreaterThan(
      FEEDBACK_SUMMARY_MAX_OUTPUT_TOKENS,
    );
  });
});

describe("FeedbackCampaignSummaryModel", () => {
  const config = {
    get: (key: string) => (key === "OPENAI_API_KEY" ? "test-key" : undefined),
  } as ConfigService<Environment, true>;
  const narrative = {
    curiosities: [],
    gossip: [],
    actions: [],
    wentWell: [],
    wentWrong: [],
    missing: null,
  };

  beforeEach(() => vi.clearAllMocks());

  it("waits for capacity before renewing the claim and calling the provider", async () => {
    const limiter = new ProviderCallLimiter(1);
    const occupied = Promise.withResolvers<void>();
    const holding = limiter.run(() => occupied.promise);
    const model = new FeedbackCampaignSummaryModel(config, limiter);
    const order: string[] = [];
    const renewClaim = vi.fn(async () => {
      order.push("renew");
    });
    vi.mocked(generateObject).mockImplementationOnce(async () => {
      order.push("provider");
      return { object: narrative } as Awaited<
        ReturnType<typeof generateObject>
      >;
    });

    const generated = model.generate("Campaign evidence", renewClaim);
    await setImmediate();
    expect(renewClaim).not.toHaveBeenCalled();
    expect(generateObject).not.toHaveBeenCalled();

    occupied.resolve();
    await holding;
    await expect(generated).resolves.toEqual(narrative);
    expect(order).toEqual(["renew", "provider"]);
  });

  it("preserves a rejected claim guard and releases the slot without a paid call", async () => {
    const limiter = new ProviderCallLimiter(1);
    const model = new FeedbackCampaignSummaryModel(config, limiter);
    const superseded = new Error("claim superseded");

    await expect(
      model.generate("Campaign evidence", async () => {
        throw superseded;
      }),
    ).rejects.toBe(superseded);

    expect(generateObject).not.toHaveBeenCalled();
    await expect(limiter.run(async () => "next")).resolves.toBe("next");
  });
});
