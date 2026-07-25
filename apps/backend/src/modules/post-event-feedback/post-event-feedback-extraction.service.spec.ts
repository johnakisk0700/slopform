import { APICallError } from "ai";
import { describe, expect, it } from "vitest";

import { ASSISTANT_MODEL_ADAPTERS } from "../assistant/assistant-models.js";
import {
  FEEDBACK_EXTRACTION_DEFAULT_MODEL,
  FeedbackExtractionGenerationError,
  resolveFeedbackExtractionModel,
  toGenerationError,
} from "./post-event-feedback-extraction.service.js";

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
});
