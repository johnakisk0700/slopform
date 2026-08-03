import {
  APICallError,
  NoObjectGeneratedError,
  RetryError,
  type LanguageModelUsage,
} from "ai";
import { describe, expect, it } from "vitest";

import {
  ASSISTANT_MODEL_ADAPTERS,
  assistantModelAdapter,
} from "../../assistant/assistant-models.js";
import type { AssistantModel } from "../../assistant/assistant.schemas.js";
import { FeedbackAttentionClassificationValidationError } from "./attention-classification.js";
import {
  FEEDBACK_ATTENTION_CLASSIFICATION_MAX_OUTPUT_TOKENS,
  FEEDBACK_ATTENTION_CLASSIFICATION_THINKING_MAX_OUTPUT_TOKENS,
  FEEDBACK_EXTRACTION_DEFAULT_MODEL,
  FEEDBACK_EXTRACTION_MAX_OUTPUT_TOKENS,
  FEEDBACK_EXTRACTION_THINKING_MAX_OUTPUT_TOKENS,
  DEFAULT_FEEDBACK_REPLY_REASONING_EFFORT,
  FeedbackExtractionGenerationError,
  feedbackAttentionClassificationMaxOutputTokens,
  feedbackExtractionMaxOutputTokens,
  feedbackExtractionProviderOptions,
  isFeedbackProviderIncident,
  resolveFeedbackAttentionReasoningEffort,
  resolveFeedbackExtractionModel,
  resolveFeedbackExtractionReasoningEffort,
  resolveFeedbackExtractionServiceTier,
  resolveFeedbackReplyReasoningEffort,
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
  // registry is what decides this: the function keys off the adapter's provider.
  // An earlier version of this test asserted the OpenRouter shape for every
  // entry and noted that the other branch was unreachable — which held only
  // while every model routed through OpenRouter. When Luna moved to OpenAI that
  // branch returned `undefined`, meaning «no reasoning field», meaning the
  // provider's own default effort against a 1,024-token ceiling. Silent, billed
  // per message, and visible only as a truncated classification.
  //
  // The classifier is no longer pinned there — `FEEDBACK_ATTENTION_REASONING_EFFORT`
  // can raise it — so what this now guards is the *default*: unconfigured, the
  // call still sends an explicit `none` in whichever spelling the route needs.
  it("defaults the bounded classifier task to no reasoning, in each provider's own spelling", () => {
    for (const id of Object.keys(
      ASSISTANT_MODEL_ADAPTERS,
    ) as AssistantModel[]) {
      const expected =
        assistantModelAdapter(id).provider === "openai"
          ? { openai: { reasoningEffort: "none" } }
          : { openrouter: { reasoning: { effort: "none" } } };
      expect(
        feedbackExtractionProviderOptions(
          id,
          resolveFeedbackAttentionReasoningEffort(undefined),
        ),
        id,
      ).toEqual(expected);
    }
  });

  it("sends no reasoning field until one is configured", () => {
    expect(resolveFeedbackExtractionReasoningEffort(undefined)).toBeUndefined();
    expect(resolveFeedbackExtractionReasoningEffort("")).toBeUndefined();
    expect(
      feedbackExtractionProviderOptions("openai/gpt-5.6-luna", undefined),
    ).toBeUndefined();
    expect(() => resolveFeedbackExtractionReasoningEffort("maximum")).toThrow(
      /FEEDBACK_EXTRACTION_REASONING_EFFORT/u,
    );
  });

  it("defaults the participant-facing writer to low and accepts an explicit effort", () => {
    expect(DEFAULT_FEEDBACK_REPLY_REASONING_EFFORT).toBe("low");
    expect(resolveFeedbackReplyReasoningEffort(undefined)).toBe("low");
    expect(resolveFeedbackReplyReasoningEffort("")).toBe("low");
    expect(resolveFeedbackReplyReasoningEffort("medium")).toBe("medium");
    expect(() => resolveFeedbackReplyReasoningEffort("tiny")).toThrow(
      /FEEDBACK_REPLY_REASONING_EFFORT/u,
    );
  });

  // Probed against the responses API on 2026-07-31: `max` answered 200 where an
  // invented effort answers 400. `maximum` above is the near-miss that must
  // still be refused, which is why both live in this file.
  it("accepts the max effort OpenAI added above xhigh", () => {
    expect(resolveFeedbackExtractionReasoningEffort("max")).toBe("max");
    expect(resolveFeedbackAttentionReasoningEffort("max")).toBe("max");
    expect(
      feedbackExtractionProviderOptions("openai/gpt-5.6-luna", "max"),
    ).toEqual({ openai: { reasoningEffort: "max" } });
    expect(feedbackExtractionMaxOutputTokens("max")).toBe(
      FEEDBACK_EXTRACTION_THINKING_MAX_OUTPUT_TOKENS,
    );
  });

  // The two settings share a vocabulary and disagree about the empty case on
  // purpose. Extraction unset means «omit the field»; the classifier has always
  // sent an explicit `none`, and unset must keep doing exactly that rather than
  // handing a 1,024-token ceiling to whatever the provider defaults to.
  it("defaults the classifier effort to an explicit none, not to an omitted field", () => {
    expect(resolveFeedbackAttentionReasoningEffort(undefined)).toBe("none");
    expect(resolveFeedbackAttentionReasoningEffort("")).toBe("none");
    expect(() => resolveFeedbackAttentionReasoningEffort("maximum")).toThrow(
      /FEEDBACK_ATTENTION_REASONING_EFFORT/u,
    );
  });

  it("spells a configured classifier effort for the provider that receives it", () => {
    expect(
      feedbackExtractionProviderOptions(
        "openai/gpt-5.6-luna",
        resolveFeedbackAttentionReasoningEffort("high"),
      ),
    ).toEqual({ openai: { reasoningEffort: "high" } });
    expect(
      feedbackExtractionProviderOptions(
        "google/gemini-3.6-flash",
        resolveFeedbackAttentionReasoningEffort("low"),
      ),
    ).toEqual({ openrouter: { reasoning: { effort: "low" } } });
  });

  // 1,024 is a batch of verdicts and nothing else. A thinking classifier spends
  // that on reasoning before it writes a character — the same failure the
  // extraction call hit at 2,048 — so the ceiling has to move with the effort.
  it("raises the classifier ceiling whenever the classifier is allowed to think", () => {
    expect(feedbackAttentionClassificationMaxOutputTokens("none")).toBe(
      FEEDBACK_ATTENTION_CLASSIFICATION_MAX_OUTPUT_TOKENS,
    );
    expect(feedbackAttentionClassificationMaxOutputTokens(undefined)).toBe(
      FEEDBACK_ATTENTION_CLASSIFICATION_MAX_OUTPUT_TOKENS,
    );
    for (const effort of ["low", "medium", "high", "xhigh", "max"] as const) {
      expect(
        feedbackAttentionClassificationMaxOutputTokens(effort),
        effort,
      ).toBe(FEEDBACK_ATTENTION_CLASSIFICATION_THINKING_MAX_OUTPUT_TOKENS);
    }
    expect(FEEDBACK_ATTENTION_CLASSIFICATION_THINKING_MAX_OUTPUT_TOKENS).toBe(
      FEEDBACK_EXTRACTION_THINKING_MAX_OUTPUT_TOKENS,
    );
  });

  it("omits the service tier until one is configured, and refuses an unknown one", () => {
    expect(resolveFeedbackExtractionServiceTier(undefined)).toBeUndefined();
    expect(resolveFeedbackExtractionServiceTier("")).toBeUndefined();
    for (const tier of ["default", "flex", "priority"] as const) {
      expect(resolveFeedbackExtractionServiceTier(tier)).toBe(tier);
    }
    // `auto` is a real SDK value this module deliberately does not offer: it
    // means the same as leaving the setting empty, and two spellings of one
    // behaviour is how a config comes to say one thing and mean another.
    for (const junk of ["auto", "fast", "Priority"]) {
      expect(() => resolveFeedbackExtractionServiceTier(junk), junk).toThrow(
        /FEEDBACK_EXTRACTION_SERVICE_TIER/u,
      );
    }
  });

  // OpenRouter routes between upstreams itself, so a `serviceTier` sent there is
  // not rejected — it is ignored, and the campaign reads as though it had bought
  // the fast lane it is not getting. This function is the only place that builds
  // the block, so it is the only place the drop can be guaranteed.
  it("sends the service tier only to models routed direct to OpenAI", () => {
    expect(
      feedbackExtractionProviderOptions(
        "openai/gpt-5.6-luna",
        "max",
        "priority",
      ),
    ).toEqual({ openai: { reasoningEffort: "max", serviceTier: "priority" } });
    expect(
      feedbackExtractionProviderOptions("openai/gpt-5.6-luna", "none", "flex"),
    ).toEqual({ openai: { reasoningEffort: "none", serviceTier: "flex" } });
    // No effort at all, but a tier: the block still has to exist.
    expect(
      feedbackExtractionProviderOptions(
        "openai/gpt-5.6-luna",
        undefined,
        "default",
      ),
    ).toEqual({ openai: { serviceTier: "default" } });
    expect(
      feedbackExtractionProviderOptions(
        "google/gemini-3.6-flash",
        "high",
        "priority",
      ),
    ).toEqual({ openrouter: { reasoning: { effort: "high" } } });
    expect(
      feedbackExtractionProviderOptions(
        "google/gemini-3.6-flash",
        undefined,
        "priority",
      ),
    ).toBeUndefined();
  });

  // `serviceTier: undefined` is still an own property and would be serialised
  // into the request body, so an unset tier must be absent from the object, not
  // present-and-undefined.
  it("omits the service tier key entirely when it is unset", () => {
    const options = feedbackExtractionProviderOptions(
      "openai/gpt-5.6-luna",
      "high",
    );

    expect(options).toEqual({ openai: { reasoningEffort: "high" } });
    expect(Object.keys(options?.openai ?? {})).toEqual(["reasoningEffort"]);
    expect(
      feedbackExtractionProviderOptions(
        "openai/gpt-5.6-luna",
        undefined,
        undefined,
      ),
    ).toBeUndefined();
  });

  it("spells the configured effort for the provider that receives it", () => {
    expect(
      feedbackExtractionProviderOptions("openai/gpt-5.6-luna", "xhigh"),
    ).toEqual({ openai: { reasoningEffort: "xhigh" } });
    expect(
      feedbackExtractionProviderOptions("google/gemini-3.6-flash", "high"),
    ).toEqual({ openrouter: { reasoning: { effort: "high" } } });
  });

  // The measured failure this guards: at `xhigh` Luna spent the entire 2,048
  // budget thinking and emitted no object at all, which this module maps to a
  // retryable error — so the run pays for the same silence on every attempt.
  it("raises the output ceiling whenever the model is allowed to think", () => {
    expect(feedbackExtractionMaxOutputTokens(undefined)).toBe(
      FEEDBACK_EXTRACTION_MAX_OUTPUT_TOKENS,
    );
    expect(feedbackExtractionMaxOutputTokens("none")).toBe(
      FEEDBACK_EXTRACTION_MAX_OUTPUT_TOKENS,
    );
    for (const effort of ["low", "medium", "high", "xhigh", "max"] as const) {
      expect(feedbackExtractionMaxOutputTokens(effort), effort).toBe(
        FEEDBACK_EXTRACTION_THINKING_MAX_OUTPUT_TOKENS,
      );
    }
    expect(FEEDBACK_EXTRACTION_THINKING_MAX_OUTPUT_TOKENS).toBeGreaterThan(
      FEEDBACK_EXTRACTION_MAX_OUTPUT_TOKENS,
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

  it("parks an exhausted OpenAI credit balance without immediate retries", () => {
    const error = toGenerationError(
      new APICallError({
        message: "quota exceeded",
        url: "https://api.openai.com/v1/responses",
        requestBodyValues: {},
        statusCode: 429,
        isRetryable: true,
        responseBody: JSON.stringify({
          error: {
            type: "insufficient_quota",
            code: "credit_balance_exhausted",
            message: "not persisted",
          },
        }),
      }),
    );

    expect(error).toMatchObject({
      code: "provider_rejected",
      retryable: false,
      failureCause: "provider_error",
      failureDetail: "http_429_credit_balance_exhausted",
    });
    expect(isFeedbackProviderIncident(error)).toBe(true);
  });

  it("does not infer an account fault from provider prose", () => {
    const error = toGenerationError(
      new APICallError({
        message: "credit_balance_exhausted",
        url: "https://api.openai.com/v1/responses",
        requestBodyValues: {},
        statusCode: 429,
        isRetryable: true,
        responseBody: "not-json",
      }),
    );

    expect(error).toMatchObject({
      code: "extraction_failed",
      retryable: true,
      failureCause: "provider_error",
      failureDetail: "http_429",
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

        expect(error).toMatchObject({
          failureCause: cause,
          failureDetail: `http_${isRetryable ? 503 : 400}`,
        });
      },
    );

    // The 2026-07-27 incident, as a classification question. Each of these is
    // non-retryable, so before the status was read every one of them arrived as
    // `provider_refusal` — the class that speaks to the participant and queues an
    // operator. None of them is about the message.
    it.each([401, 402, 403, 404] as const)(
      "reads a non-retryable %s as the provider's fault, not the conversation's",
      (statusCode) => {
        const error = toGenerationError(
          new APICallError({
            message: "provider said no",
            url: "https://openrouter.ai",
            requestBodyValues: {},
            statusCode,
            isRetryable: false,
          }),
        );

        expect(error).toMatchObject({
          code: "provider_rejected",
          retryable: false,
          failureCause: "provider_error",
          failureDetail: `http_${statusCode}`,
        });
        expect(isFeedbackProviderIncident(error)).toBe(true);
      },
    );

    // The other half of the same test: a rejection of *this* request keeps
    // today's treatment, and the park must not swallow it.
    it.each([400, 422] as const)(
      "keeps a non-retryable %s a refusal about this request",
      (statusCode) => {
        const error = toGenerationError(
          new APICallError({
            message: "provider said no",
            url: "https://openrouter.ai",
            requestBodyValues: {},
            statusCode,
            isRetryable: false,
          }),
        );

        expect(error.failureCause).toBe("provider_refusal");
        expect(isFeedbackProviderIncident(error)).toBe(false);
      },
    );

    it("reads the status through a RetryError wrapper", () => {
      // The SDK wraps the last attempt, and the wrapper carries no status of its
      // own. Unwrapping is what keeps an empty balance classified the same way
      // whether or not the provider layer retried it first.
      const error = toGenerationError(
        new RetryError({
          message: "failed after 3 attempts",
          reason: "maxRetriesExceeded",
          errors: [
            new APICallError({
              message: "insufficient credits",
              url: "https://openrouter.ai",
              requestBodyValues: {},
              statusCode: 402,
              isRetryable: false,
            }),
          ],
        }),
      );

      expect(error.failureCause).toBe("provider_error");
    });

    it("does not treat a refusal or a schema failure as a provider incident", () => {
      for (const error of [
        new FeedbackExtractionGenerationError(
          "provider_rejected",
          false,
          "provider_refusal",
        ),
        new FeedbackExtractionGenerationError(
          "extraction_failed",
          true,
          "validation_failed",
        ),
        new FeedbackExtractionGenerationError("extraction_failed", true),
        new Error("mongo went away"),
      ]) {
        expect(isFeedbackProviderIncident(error)).toBe(false);
      }
    });

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
