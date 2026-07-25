import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import {
  APICallError,
  NoObjectGeneratedError,
  RetryError,
  TypeValidationError,
  generateObject,
  type LanguageModel,
} from "ai";

import type { Environment } from "../../infrastructure/config/environment.js";
import { assistantModelAdapter } from "../assistant/assistant-models.js";
import {
  assistantModelSchema,
  type AssistantModel,
} from "../assistant/assistant.schemas.js";
import type { FeedbackExtractionPrompt } from "./post-event-feedback-prompt.js";
import { resolveFeedbackExtractionProviderSettings } from "./post-event-feedback-provider-safety.js";
import {
  feedbackExtractionProposalSchema,
  type FeedbackExtractionProposal,
} from "./post-event-feedback-extraction.schemas.js";

export const FEEDBACK_EXTRACTION_FAILURE_CODES = [
  "provider_unavailable",
  "provider_rejected",
  "extraction_failed",
] as const;

export type FeedbackExtractionFailureCode =
  (typeof FEEDBACK_EXTRACTION_FAILURE_CODES)[number];

/**
 * The bounded cause vocabulary a permanently failed run reports.
 *
 * The failure code above says what the SDK threw; this says what an operator
 * should conclude. They are separate because the interesting case collapses
 * them: a provider that refuses to emit structured output for a safety
 * disclosure surfaces as an ordinary "no object generated", which is
 * indistinguishable from a schema mishap unless the finish reason is read.
 */
export const FEEDBACK_EXTRACTION_FAILURE_CAUSES = [
  /** The provider declined to answer — a content filter or a hard rejection. */
  "provider_refusal",
  /** The provider was unreachable, misconfigured or erroring. */
  "provider_error",
  /** A response arrived but never satisfied the agreed schema. */
  "validation_failed",
  "unknown",
] as const;

export type FeedbackExtractionFailureCause =
  (typeof FEEDBACK_EXTRACTION_FAILURE_CAUSES)[number];

/** Matches the assistant's two-minute total bound on a single provider call. */
export const FEEDBACK_EXTRACTION_TIMEOUT_MILLISECONDS = 120_000;

export class FeedbackExtractionGenerationError extends Error {
  /** Named `failureCause` so it never shadows the built-in `Error.cause`. */
  constructor(
    readonly code: FeedbackExtractionFailureCode,
    readonly retryable: boolean,
    readonly failureCause: FeedbackExtractionFailureCause = "unknown",
  ) {
    super(`Feedback extraction failed: ${code}`);
    this.name = FeedbackExtractionGenerationError.name;
  }
}

export interface FeedbackExtractionUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
}

export interface FeedbackExtractionGenerationResult {
  readonly model: AssistantModel;
  readonly proposal: FeedbackExtractionProposal;
  readonly usage: FeedbackExtractionUsage;
}

/**
 * D12's default. It is deliberately its own constant rather than an alias of
 * the assistant default: the two features choose a model for different reasons,
 * and changing one must not silently change the other.
 */
export const FEEDBACK_EXTRACTION_DEFAULT_MODEL: AssistantModel =
  "google/gemini-3.6-flash";

/**
 * Resolves the configured extraction model against the shared provider
 * registry. An unrecognised id fails at worker start, because the alternative —
 * quietly using the default — would bill and log a model nobody asked for.
 */
export function resolveFeedbackExtractionModel(
  configured: string | undefined,
): AssistantModel {
  if (!configured) {
    return FEEDBACK_EXTRACTION_DEFAULT_MODEL;
  }
  const parsed = assistantModelSchema.safeParse(configured);
  if (!parsed.success) {
    throw new Error(
      `FEEDBACK_EXTRACTION_MODEL must be a registered model id, received "${configured}"`,
    );
  }
  return parsed.data;
}

/**
 * The model boundary for `feedback.extract.v1`.
 *
 * It reuses the assistant's provider registry — the public model id maps to
 * exactly one provider id — so extraction cannot invent a provider mapping of
 * its own or fall back to a different model when a key is missing. A missing
 * key is a permanent failure, not a substitution.
 *
 * Output is structured and Zod-validated at the boundary. Whatever survives is
 * still only a *proposal*: the domain rules in the validation module decide
 * what may be written.
 */
@Injectable()
export class PostEventFeedbackExtractionModel {
  private readonly openAiProvider: ReturnType<typeof createOpenAI> | undefined;
  private readonly openRouterProvider:
    ReturnType<typeof createOpenRouter> | undefined;
  readonly model: AssistantModel;

  constructor(private readonly config: ConfigService<Environment, true>) {
    const openAiKey = this.config.get("OPENAI_API_KEY", { infer: true });
    const openRouterKey = this.config.get("OPENROUTER_API_KEY", {
      infer: true,
    });

    this.openAiProvider = openAiKey
      ? createOpenAI({ apiKey: openAiKey })
      : undefined;
    this.openRouterProvider = openRouterKey
      ? createOpenRouter({ apiKey: openRouterKey })
      : undefined;
    this.model = resolveFeedbackExtractionModel(
      this.config.get("FEEDBACK_EXTRACTION_MODEL", { infer: true }),
    );
  }

  async propose(
    prompt: FeedbackExtractionPrompt,
  ): Promise<FeedbackExtractionGenerationResult> {
    const model = this.resolveProviderModel(this.model);

    try {
      const result = await generateObject({
        model,
        schema: feedbackExtractionProposalSchema,
        schemaName: "post_event_feedback_extraction",
        schemaDescription:
          "Structured post-event feedback extraction proposal validated by the application before persistence.",
        system: prompt.system,
        prompt: prompt.user,
        maxOutputTokens: 2_048,
        // BullMQ owns visible retries, exactly as the assistant worker does.
        maxRetries: 0,
        abortSignal: AbortSignal.timeout(
          FEEDBACK_EXTRACTION_TIMEOUT_MILLISECONDS,
        ),
      });

      return {
        model: this.model,
        proposal: feedbackExtractionProposalSchema.parse(result.object),
        usage: {
          inputTokens: result.usage.inputTokens ?? null,
          outputTokens: result.usage.outputTokens ?? null,
          totalTokens: result.usage.totalTokens ?? null,
        },
      };
    } catch (error) {
      throw toGenerationError(error);
    }
  }

  private resolveProviderModel(model: AssistantModel): LanguageModel {
    const adapter = assistantModelAdapter(model);

    if (adapter.provider === "openrouter") {
      if (!this.openRouterProvider) {
        throw new FeedbackExtractionGenerationError(
          "provider_unavailable",
          false,
          "provider_error",
        );
      }
      // Scoped here on purpose: this provider instance serves
      // `feedback.extract.v1` and nothing else, so permissive thresholds cannot
      // leak into the assistant, which builds its own clients from the same
      // registry.
      const settings = resolveFeedbackExtractionProviderSettings(adapter);
      return settings
        ? this.openRouterProvider(adapter.providerModelId, settings)
        : this.openRouterProvider(adapter.providerModelId);
    }

    if (!this.openAiProvider) {
      throw new FeedbackExtractionGenerationError(
        "provider_unavailable",
        false,
        "provider_error",
      );
    }
    return this.openAiProvider(adapter.providerModelId);
  }
}

/**
 * Configuration and schema faults are permanent — retrying repeats the same
 * rejection and the same bill. Timeouts, rate limits and provider 5xx are
 * transient and left to BullMQ.
 *
 * The cause class is derived alongside the code because the two answer
 * different questions. A content filter that stops generation reports the same
 * `extraction_failed` code as a malformed object, but only the finish reason
 * distinguishes "the provider refused to discuss this" from "the model fumbled
 * the schema" — and only the first one means an operator should read the
 * conversation.
 */
export function toGenerationError(
  error: unknown,
): FeedbackExtractionGenerationError {
  if (error instanceof FeedbackExtractionGenerationError) {
    return error;
  }
  if (APICallError.isInstance(error)) {
    return new FeedbackExtractionGenerationError(
      error.isRetryable ? "extraction_failed" : "provider_rejected",
      error.isRetryable,
      error.isRetryable ? "provider_error" : "provider_refusal",
    );
  }
  if (RetryError.isInstance(error)) {
    const lastError = error.lastError;
    const retryable =
      !APICallError.isInstance(lastError) || lastError.isRetryable;
    return new FeedbackExtractionGenerationError(
      retryable ? "extraction_failed" : "provider_rejected",
      retryable,
      retryable ? "provider_error" : "provider_refusal",
    );
  }
  if (NoObjectGeneratedError.isInstance(error)) {
    // The model produced something that is not the agreed shape. One retry can
    // legitimately fix that, so it stays retryable and BullMQ bounds it. A
    // `content-filter` finish reason is the exception that matters: the
    // provider declined, and repeating the same prompt will decline again.
    return new FeedbackExtractionGenerationError(
      "extraction_failed",
      true,
      error.finishReason === "content-filter"
        ? "provider_refusal"
        : "validation_failed",
    );
  }
  if (TypeValidationError.isInstance(error)) {
    return new FeedbackExtractionGenerationError(
      "extraction_failed",
      true,
      "validation_failed",
    );
  }
  return new FeedbackExtractionGenerationError(
    "extraction_failed",
    true,
    "unknown",
  );
}
