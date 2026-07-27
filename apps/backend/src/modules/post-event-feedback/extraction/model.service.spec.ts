import {
  APICallError,
  NoObjectGeneratedError,
  type LanguageModelUsage,
} from "ai";
import { describe, expect, it } from "vitest";

import { ASSISTANT_MODEL_ADAPTERS } from "../../assistant/assistant-models.js";
import { FeedbackAttentionClassificationValidationError } from "./attention-classification.js";
import {
  FEEDBACK_EXTRACTION_DEFAULT_MODEL,
  FeedbackExtractionGenerationError,
  feedbackAttentionClassificationProviderOptions,
  resolveFeedbackExtractionModel,
  toGenerationError,
} from "./model.service.js";

describe("feedback extraction model selection", () => {
  it("defaults to the D12 model", () => {
    expect(resolveFeedbackExtractionModel(undefined)).toBe(
      "google/gemini-3.6-flash",
    );
    expect(FEEDBACK_EXTRACTION_DEFAULT_MODEL).toBe("google/gemini-3.6-flash");
  });

  it("accepts any model in the shared provider registry", () => {
    for (const id of Object.keys(ASSISTANT_MODEL_ADAPTERS)) {
      expect(resolveFeedbackExtractionModel(id)).toBe(id);
    }
  });

  it("refuses an unregistered model instead of quietly using the default", () => {
    expect(() => resolveFeedbackExtractionModel("google/gemini-9")).toThrow(
      /registered model id/u,
    );
  });

  // Asserted across the whole registry rather than on one id, because the
  // registry is what decides this: the function keys off the adapter's provider,
  // and every entry now routes through OpenRouter. The `undefined` branch is
  // still correct code for a future non-OpenRouter provider but is no longer
  // reachable through any registered model, so no model id can stand for it.
  it("disables OpenRouter reasoning for the bounded classifier task", () => {
    for (const id of Object.keys(ASSISTANT_MODEL_ADAPTERS)) {
      expect(
        feedbackAttentionClassificationProviderOptions(
          id as keyof typeof ASSISTANT_MODEL_ADAPTERS,
        ),
        id,
      ).toEqual({ openrouter: { reasoning: { effort: "none" } } });
    }
  });
});

describe("feedback extraction failure mapping", () => {
  it("keeps a provider rejection permanent", () => {
    const error = toGenerationError(
      new APICallError({
        message: "bad request",
        url: "https://openrouter.ai",
        requestBodyValues: {},
        statusCode: 400,
        isRetryable: false,
      }),
    );

    expect(error).toBeInstanceOf(FeedbackExtractionGenerationError);
    expect(error).toMatchObject({
      code: "provider_rejected",
      retryable: false,
    });
  });

  it("lets a retryable provider failure reach BullMQ", () => {
    const error = toGenerationError(
      new APICallError({
        message: "rate limited",
        url: "https://openrouter.ai",
        requestBodyValues: {},
        statusCode: 429,
        isRetryable: true,
      }),
    );

    expect(error).toMatchObject({
      code: "extraction_failed",
      retryable: true,
    });
  });

  it("treats an unknown failure as retryable rather than losing the run", () => {
    expect(toGenerationError(new Error("socket hang up"))).toMatchObject({
      code: "extraction_failed",
      retryable: true,
    });
  });

  it("passes an existing generation error through unchanged", () => {
    const original = new FeedbackExtractionGenerationError(
      "provider_unavailable",
      false,
    );

    expect(toGenerationError(original)).toBe(original);
  });

  it("retries an incomplete attention classification as validation failure", () => {
    expect(
      toGenerationError(
        new FeedbackAttentionClassificationValidationError(
          "missing message result",
        ),
      ),
    ).toMatchObject({
      code: "extraction_failed",
      retryable: true,
      failureCause: "validation_failed",
    });
  });

  // The classifier reads only `finishReason`, so usage is noise here.
  const emptyUsage: LanguageModelUsage = {
    inputTokens: undefined,
    outputTokens: undefined,
    totalTokens: undefined,
    inputTokenDetails: {
      noCacheTokens: undefined,
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined,
    },
    outputTokenDetails: {
      textTokens: undefined,
      reasoningTokens: undefined,
    },
  };

  describe("cause classification", () => {
    it("reads a content filter as a refusal, not a schema mishap", () => {
      // The acceptance-run failure: the provider stopped on its own policy and
      // reported the same `extraction_failed` code a malformed object would.
      // Only the finish reason separates "it refused" from "it fumbled".
      const error = toGenerationError(
        new NoObjectGeneratedError({
          message: "No object generated",
          response: { id: "1", timestamp: new Date(), modelId: "gemini" },
          usage: emptyUsage,
          finishReason: "content-filter",
        }),
      );

      expect(error).toMatchObject({
        code: "extraction_failed",
        retryable: true,
        failureCause: "provider_refusal",
      });
    });

    it("reads a malformed object as a validation failure", () => {
      const error = toGenerationError(
        new NoObjectGeneratedError({
          message: "No object generated",
          response: { id: "1", timestamp: new Date(), modelId: "gemini" },
          usage: emptyUsage,
          finishReason: "stop",
        }),
      );

      expect(error.failureCause).toBe("validation_failed");
    });

    it.each([
      [false, "provider_refusal"],
      [true, "provider_error"],
    ] as const)(
      "maps an API call error (retryable=%s) to %s",
      (isRetryable, cause) => {
        const error = toGenerationError(
          new APICallError({
            message: "provider said no",
            url: "https://openrouter.ai",
            requestBodyValues: {},
            statusCode: isRetryable ? 503 : 400,
            isRetryable,
          }),
        );

        expect(error.failureCause).toBe(cause);
      },
    );

    it("falls back to unknown for anything unrecognised", () => {
      expect(toGenerationError(new Error("socket hang up")).failureCause).toBe(
        "unknown",
      );
    });

    it("defaults the cause when one is not supplied", () => {
      expect(
        new FeedbackExtractionGenerationError("provider_unavailable", false)
          .failureCause,
      ).toBe("unknown");
    });
  });
});
