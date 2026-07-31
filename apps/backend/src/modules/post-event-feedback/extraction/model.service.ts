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

import type { Environment } from "../../../infrastructure/config/environment.js";
import {
  assistantModelAdapter,
  isRetryableProviderError,
} from "../../assistant/assistant-models.js";
import {
  assistantModelSchema,
  type AssistantModel,
} from "../../assistant/assistant.schemas.js";
import {
  type FeedbackExtractionPrompt,
  estimatePromptTokens,
} from "./prompt.js";
import {
  FEEDBACK_ATTENTION_CLASSIFICATION_BATCH_SIZE,
  FeedbackAttentionClassificationValidationError,
  buildFeedbackAttentionClassificationPrompt,
  feedbackAttentionClassificationProposalSchema,
  validateFeedbackAttentionClassification,
} from "./attention-classification.js";
import { resolveFeedbackExtractionProviderSettings } from "./permissive-safety-settings.js";
import {
  feedbackExtractionProposalSchema,
  type FeedbackExtractionMessageView,
  type FeedbackExtractionProposal,
  type FeedbackExtractionSafetySignalProposal,
} from "./extraction.schemas.js";

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

/**
 * HTTP statuses that mean «our side of the arrangement with the provider is
 * broken», not «this conversation defeated the model».
 *
 * They are all *non-retryable*, which is exactly why they need naming. The
 * retryable half of a provider fault (a timeout, a 429, a 503) already reaches
 * `provider_error` through `isRetryable`; these do not, and until this list
 * existed every one of them was classified `provider_refusal` — the class that
 * means a human should read the transcript. An exhausted OpenRouter balance
 * therefore looked identical to a content filter stopping on a disclosure, and
 * on 2026-07-27 thirty-six participants were told the analysis of their evening
 * had failed because of our billing.
 *
 * 401 is a wrong or missing key, 402 is out of credit, 403 is a forbidden route
 * or region, 404 is a model id the provider does not serve. Every one of them is
 * identical for every conversation in the campaign and none of them is repaired
 * by reading a message — they are repaired by somebody topping up, fixing a key
 * or correcting a model id, after which the very same request succeeds.
 *
 * 400 and 422 are deliberately absent. Those say the provider rejected *this
 * request*, which is the bucket that keeps today's behaviour: fall back once,
 * file a note and ask for a person.
 */
export const FEEDBACK_PROVIDER_ACCOUNT_FAULT_STATUS_CODES: readonly number[] = [
  401, 402, 403, 404,
];

/** Matches the assistant's two-minute total bound on a single provider call. */
export const FEEDBACK_EXTRACTION_TIMEOUT_MILLISECONDS = 120_000;

export class FeedbackExtractionGenerationError extends Error {
  /** Named `failureCause` so it never shadows the built-in `Error.cause`. */
  constructor(
    readonly code: FeedbackExtractionFailureCode,
    readonly retryable: boolean,
    readonly failureCause: FeedbackExtractionFailureCause = "unknown",
    /**
     * Bounded description of the underlying error when `failureCause` could not
     * name it. Empty for every classified cause, because there the cause is the
     * description. Never carries participant text.
     */
    readonly failureDetail: string = "",
  ) {
    super(`Feedback extraction failed: ${code}`);
    this.name = FeedbackExtractionGenerationError.name;
  }
}

/**
 * Whether this failure is the provider's, and therefore everybody's.
 *
 * The single structural question the terminal failure path asks. `provider_error`
 * is not a guess: it is set only where the code can point at the provider — a
 * missing client for the configured route, an `APICallError` the provider marked
 * retryable, or one of the account-fault statuses above. Nothing here reads an
 * error message.
 *
 * Everything else — a content filter, a schema the model never satisfied, a
 * validation refusal, an unrecognised throw — is treated as a fault of *this*
 * conversation's run, because that is the only assumption that keeps a
 * disclosure in front of a person.
 */
export function isFeedbackProviderIncident(error: unknown): boolean {
  return (
    error instanceof FeedbackExtractionGenerationError &&
    error.failureCause === "provider_error"
  );
}

export interface FeedbackExtractionUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
}

/**
 * What the deterministic rehearsal stub reports as its model id.
 *
 * Deliberately not a registered `AssistantModel`: the id is written verbatim
 * into `extraction.model` on the conversation and onto every result row, and a
 * rehearsal that stamped a real provider id onto rows no provider produced
 * would leave that fiction in the database for whoever reads it next. It is
 * also unresolvable by `resolveProviderModel`, which is what guarantees the
 * marker can never be used to reach OpenRouter.
 */
export const FEEDBACK_EXTRACTION_STUB_MODEL_ID = "stub/burst-rehearsal";

/**
 * The model id an extraction run reports having used.
 *
 * Wider than `AssistantModel` because a run is not always a provider call. The
 * provider boundary below stays narrow on purpose.
 */
export type FeedbackExtractionModelId =
  AssistantModel | typeof FEEDBACK_EXTRACTION_STUB_MODEL_ID;

export interface FeedbackExtractionGenerationResult {
  readonly model: FeedbackExtractionModelId;
  readonly proposal: FeedbackExtractionProposal;
  readonly usage: FeedbackExtractionUsage;
}

export interface FeedbackAttentionClassificationGenerationResult {
  readonly model: FeedbackExtractionModelId;
  readonly signals: readonly FeedbackExtractionSafetySignalProposal[];
  /**
   * Messages in this run aimed abusively at us. Never a safety signal — see
   * `FeedbackAttentionClassificationResult` for why the two travel apart.
   */
  readonly hostileMessageIds: readonly string[];
  /**
   * Incident messages that say what happened. Only the safety assurance reads
   * this — see `FeedbackAttentionClassificationResult`.
   */
  readonly describedIncidentMessageIds: readonly string[];
  readonly usage: FeedbackExtractionUsage;
  readonly estimatedPromptTokens: number;
}

/**
 * Everything the extractor depends on, named so a substitute can be checked.
 *
 * The worker swaps in a deterministic stub for the burst rehearsal, and Nest
 * resolves that at runtime — nothing would otherwise notice if the two drifted
 * apart until a rehearsal died mid-run. Both the real model and the stub
 * `implements` this, so a method added to one and missed by the other is a
 * build error.
 */
export interface FeedbackExtractionModelPort {
  readonly model: FeedbackExtractionModelId;
  propose(
    prompt: FeedbackExtractionPrompt,
  ): Promise<FeedbackExtractionGenerationResult>;
  classifyAttention(
    messages: readonly FeedbackExtractionMessageView[],
    targetMessageIds: readonly string[],
  ): Promise<FeedbackAttentionClassificationGenerationResult>;
}

/**
 * The thinking budget the extraction call may ask for, in both providers'
 * spellings.
 *
 * Deliberately not the assistant's `low | medium | high`. That enum is persisted
 * on every turn behind the `assistant_turns_effort_check` constraint; this one
 * is persisted nowhere, so widening it costs no migration. `xhigh` is offered by
 * OpenAI on Luna and is not reachable through OpenRouter, which is the whole
 * reason the Luna route moved — see `ASSISTANT_MODEL_ADAPTERS`.
 */
export const FEEDBACK_EXTRACTION_REASONING_EFFORTS = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

export type FeedbackExtractionReasoningEffort =
  (typeof FEEDBACK_EXTRACTION_REASONING_EFFORTS)[number];

/**
 * `undefined` — the default — means *send no reasoning field at all*, which is
 * what this call did before the setting existed.
 *
 * That distinction is not pedantry. Omitting the field leaves each provider on
 * its own default; sending `none` overrides it. Defaulting the new setting to
 * `none` would therefore have silently changed how the default extraction model
 * (`google/gemini-3.6-flash`, through OpenRouter) behaves on every campaign, to
 * pay for a Luna experiment. An unrecognised value throws at worker start for
 * the same reason `resolveFeedbackExtractionModel` does: the alternative is
 * billing a whole rehearsal under a setting nobody chose.
 */
export function resolveFeedbackExtractionReasoningEffort(
  configured: string | undefined,
): FeedbackExtractionReasoningEffort | undefined {
  if (!configured) {
    return undefined;
  }
  const effort = FEEDBACK_EXTRACTION_REASONING_EFFORTS.find(
    (candidate) => candidate === configured,
  );
  if (!effort) {
    throw new Error(
      `FEEDBACK_EXTRACTION_REASONING_EFFORT must be one of ${FEEDBACK_EXTRACTION_REASONING_EFFORTS.join(", ")}, received "${configured}"`,
    );
  }
  return effort;
}

/**
 * One thinking budget, spelled for whichever provider the registry chose.
 *
 * The two SDKs disagree on the shape, and a body sent in the wrong one is not an
 * error — it is ignored, and the call quietly runs at the provider's default
 * effort while the log claims otherwise.
 */
export function feedbackExtractionProviderOptions(
  model: AssistantModel,
  effort: FeedbackExtractionReasoningEffort | undefined,
):
  | NonNullable<Parameters<typeof generateObject>[0]["providerOptions"]>
  | undefined {
  if (!effort) {
    return undefined;
  }
  return assistantModelAdapter(model).provider === "openai"
    ? { openai: { reasoningEffort: effort } }
    : { openrouter: { reasoning: { effort } } };
}

/** What a run with no thinking budget needs to emit one proposal. */
export const FEEDBACK_EXTRACTION_MAX_OUTPUT_TOKENS = 2_048;

/**
 * The same ceiling once the model is allowed to think, because **reasoning
 * tokens are spent from this budget**, not from a separate one.
 *
 * Measured against `gpt-5.6-luna` on 2026-07-31 with an eight-line transcript —
 * far shorter than a real one — and a schema of this shape:
 *
 * | effort  | reasoning | total output | result                    |
 * | ------- | --------- | ------------ | ------------------------- |
 * | `none`  | 0         | 427          | completed                 |
 * | `low`   | 90        | 654          | completed                 |
 * | `high`  | 1,466     | 1,956        | completed, 92 to spare    |
 * | `xhigh` | 2,048     | 2,048        | **incomplete, no output** |
 *
 * At `xhigh` the whole 2,048 went on thinking and the model never reached the
 * object. That surfaces as `NoObjectGeneratedError`, which this module maps to a
 * *retryable* failure — so BullMQ pays for the same silence again. `high` cleared
 * it by ninety-two tokens on a transcript a fraction of the real size, which is
 * not a margin.
 *
 * A ceiling is not a charge: a call that thinks for two thousand tokens bills
 * two thousand whatever this says. It only has to be high enough that the answer
 * still fits after the thinking.
 */
export const FEEDBACK_EXTRACTION_THINKING_MAX_OUTPUT_TOKENS = 16_384;

export function feedbackExtractionMaxOutputTokens(
  effort: FeedbackExtractionReasoningEffort | undefined,
): number {
  return effort && effort !== "none"
    ? FEEDBACK_EXTRACTION_THINKING_MAX_OUTPUT_TOKENS
    : FEEDBACK_EXTRACTION_MAX_OUTPUT_TOKENS;
}

/** One batch of per-message verdicts, and nothing else, fits in this. */
export const FEEDBACK_ATTENTION_CLASSIFICATION_MAX_OUTPUT_TOKENS = 1_024;

/**
 * The classifier stays at zero thinking whatever the extraction call is doing.
 *
 * It answers a bounded per-message yes/no and is billed once per batch, so
 * reasoning buys little and costs on every message in the campaign. The bound
 * has teeth here: the batch reply is capped at 1,024 output tokens, and on the
 * table above `xhigh` alone would eat twice that before writing a character.
 *
 * Returning `undefined` for a non-OpenRouter provider — which is what this did
 * until Luna moved — is exactly that failure. It does not mean «no reasoning»;
 * it means «whatever the provider defaults to», silently, against a 1,024
 * ceiling.
 */
export function feedbackAttentionClassificationProviderOptions(
  model: AssistantModel,
):
  | NonNullable<Parameters<typeof generateObject>[0]["providerOptions"]>
  | undefined {
  return feedbackExtractionProviderOptions(model, "none");
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
export class PostEventFeedbackExtractionModel implements FeedbackExtractionModelPort {
  private readonly openAiProvider: ReturnType<typeof createOpenAI> | undefined;
  private readonly openRouterProvider:
    ReturnType<typeof createOpenRouter> | undefined;
  readonly model: AssistantModel;
  readonly reasoningEffort: FeedbackExtractionReasoningEffort | undefined;

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
    this.reasoningEffort = resolveFeedbackExtractionReasoningEffort(
      this.config.get("FEEDBACK_EXTRACTION_REASONING_EFFORT", { infer: true }),
    );
  }

  async propose(
    prompt: FeedbackExtractionPrompt,
  ): Promise<FeedbackExtractionGenerationResult> {
    const model = this.resolveProviderModel(this.model);
    const providerOptions = feedbackExtractionProviderOptions(
      this.model,
      this.reasoningEffort,
    );

    try {
      const result = await generateObject({
        model,
        schema: feedbackExtractionProposalSchema,
        schemaName: "post_event_feedback_extraction",
        schemaDescription:
          "Structured post-event feedback extraction proposal validated by the application before persistence.",
        system: prompt.system,
        prompt: prompt.user,
        maxOutputTokens: feedbackExtractionMaxOutputTokens(
          this.reasoningEffort,
        ),
        ...(providerOptions ? { providerOptions } : {}),
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

  async classifyAttention(
    messages: readonly FeedbackExtractionMessageView[],
    targetMessageIds: readonly string[],
  ): Promise<FeedbackAttentionClassificationGenerationResult> {
    const model = this.resolveProviderModel(this.model);
    const batches = chunk(
      targetMessageIds,
      FEEDBACK_ATTENTION_CLASSIFICATION_BATCH_SIZE,
    );
    const signals: FeedbackExtractionSafetySignalProposal[] = [];
    const hostileMessageIds: string[] = [];
    const describedIncidentMessageIds: string[] = [];
    const usages: FeedbackExtractionUsage[] = [];
    const providerOptions = feedbackAttentionClassificationProviderOptions(
      this.model,
    );
    let estimatedPromptTokens = 0;

    try {
      for (const batch of batches) {
        const prompt = buildFeedbackAttentionClassificationPrompt({
          messages,
          targetMessageIds: batch,
        });
        estimatedPromptTokens += estimatePromptTokens(prompt);
        const result = await generateObject({
          model,
          schema: feedbackAttentionClassificationProposalSchema,
          schemaName: "post_event_feedback_attention_classification",
          schemaDescription:
            "One contextual incident classification for every supplied participant message.",
          system: prompt.system,
          prompt: prompt.user,
          maxOutputTokens: FEEDBACK_ATTENTION_CLASSIFICATION_MAX_OUTPUT_TOKENS,
          maxRetries: 0,
          ...(providerOptions ? { providerOptions } : {}),
          abortSignal: AbortSignal.timeout(
            FEEDBACK_EXTRACTION_TIMEOUT_MILLISECONDS,
          ),
        });
        const proposal = feedbackAttentionClassificationProposalSchema.parse(
          result.object,
        );
        const classified = validateFeedbackAttentionClassification(
          proposal,
          batch,
        );
        signals.push(...classified.signals);
        hostileMessageIds.push(...classified.hostileMessageIds);
        describedIncidentMessageIds.push(
          ...classified.describedIncidentMessageIds,
        );
        usages.push({
          inputTokens: result.usage.inputTokens ?? null,
          outputTokens: result.usage.outputTokens ?? null,
          totalTokens: result.usage.totalTokens ?? null,
        });
      }
    } catch (error) {
      throw toGenerationError(error);
    }

    return {
      model: this.model,
      signals,
      hostileMessageIds,
      describedIncidentMessageIds,
      usage: combineUsage(usages),
      estimatedPromptTokens,
    };
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

function chunk<T>(items: readonly T[], size: number): readonly T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}

function combineUsage(
  usages: readonly FeedbackExtractionUsage[],
): FeedbackExtractionUsage {
  return {
    inputTokens: sumKnown(usages.map((usage) => usage.inputTokens)),
    outputTokens: sumKnown(usages.map((usage) => usage.outputTokens)),
    totalTokens: sumKnown(usages.map((usage) => usage.totalTokens)),
  };
}

function sumKnown(values: readonly (number | null)[]): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length === values.length
    ? known.reduce((total, value) => total + value, 0)
    : null;
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
    return fromApiCallError(error);
  }
  if (RetryError.isInstance(error)) {
    const lastError = error.lastError;
    if (APICallError.isInstance(lastError)) {
      return fromApiCallError(lastError);
    }
    const retryable = isRetryableProviderError(lastError);
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
  if (error instanceof FeedbackAttentionClassificationValidationError) {
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
    describeUnclassifiedError(error),
  );
}

/**
 * One provider HTTP failure, classified by what would repair it.
 *
 * Retryability decides the *code* (may BullMQ try again), and the status decides
 * the *cause* (who has to do something about it). Those two questions used to
 * share one answer, which is how a 402 became a refusal: not retryable,
 * therefore assumed to be about the message.
 *
 * The status is read from the error the provider actually produced, never from
 * its message text. A string match would be a guess, and the strings differ per
 * provider and change without notice.
 */
function fromApiCallError(
  error: APICallError,
): FeedbackExtractionGenerationError {
  const accountFault =
    error.statusCode !== undefined &&
    FEEDBACK_PROVIDER_ACCOUNT_FAULT_STATUS_CODES.includes(error.statusCode);
  return new FeedbackExtractionGenerationError(
    error.isRetryable ? "extraction_failed" : "provider_rejected",
    error.isRetryable,
    error.isRetryable || accountFault ? "provider_error" : "provider_refusal",
  );
}

/**
 * A bounded description of an error none of the branches above recognised.
 *
 * `unknown` on its own is a dead end for an operator, and it is not rare: every
 * permanent extraction failure in the 2026-07-27 rehearsal reported it, which
 * left the cause a matter of opinion — a provider content filter, a schema that
 * never validated and a 120-second abort are three different problems with
 * three different fixes, and all three land here. The constructor name and a
 * short message are enough to tell them apart and carry no participant text:
 * the message comes from the SDK or the runtime, not from the transcript.
 */
function describeUnclassifiedError(error: unknown): string {
  const name = error instanceof Error ? error.constructor.name : typeof error;
  const message = error instanceof Error ? error.message : String(error);
  return `${name}: ${message}`.slice(0, 200);
}
