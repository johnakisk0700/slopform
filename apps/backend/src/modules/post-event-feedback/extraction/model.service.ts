import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { FeedbackAnswerQuestionKey } from "@slopform/database";
import {
  APICallError,
  NoObjectGeneratedError,
  RetryError,
  TypeValidationError,
  generateObject,
  generateText,
  type LanguageModel,
} from "ai";

import { ProviderCallLimiter } from "../../../infrastructure/ai/provider-call-limiter.js";
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
  buildFeedbackReplyRewritePrompt,
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
import type { FeedbackPolicyQuestionMatch } from "./policy-answers.js";
import { resolveFeedbackExtractionProviderSettings } from "./permissive-safety-settings.js";
import {
  createFeedbackExtractionProposalSchema,
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
 * Operator-facing cause, separate from the SDK failure code. A content-filter
 * finish reason is the only way a "no object" looks different from a schema miss.
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
 * Non-retryable account/route faults (401–404). These are `provider_error`,
 * not `provider_refusal`: reading the transcript cannot repair them. OpenAI
 * empty balance arrives as retryable 429 + structured
 * `credit_balance_exhausted`. 400/422 stay conversation-local refusals.
 */
export const FEEDBACK_PROVIDER_ACCOUNT_FAULT_STATUS_CODES: readonly number[] = [
  401, 402, 403, 404,
];

/** Matches the assistant's two-minute total bound on a single provider call. */
export const FEEDBACK_EXTRACTION_TIMEOUT_MILLISECONDS = 120_000;

/**
 * Revalidated after the deployment-wide provider limiter grants a slot and
 * immediately before money can be spent. The limiter wait is intentionally
 * unbounded, so checking only before entering it would let an expired
 * conversation lease start a paid call minutes later.
 */
export type FeedbackProviderCallGuard = () => Promise<void>;

/**
 * Base class for application ownership checks run inside a granted provider
 * slot. Model error classification must preserve these verbatim: turning a
 * lost execution lease into `provider_error` would retry/fallback the wrong
 * business execution.
 */
export class FeedbackProviderCallGuardError extends Error {
  override name = "FeedbackProviderCallGuardError";
}

export class FeedbackExtractionGenerationError extends Error {
  /** Named `failureCause` so it never shadows the built-in `Error.cause`. */
  constructor(
    readonly code: FeedbackExtractionFailureCode,
    readonly retryable: boolean,
    readonly failureCause: FeedbackExtractionFailureCause = "unknown",
    /**
     * Bounded, log-safe description of the underlying error. Classified HTTP
     * failures retain only their status (`http_429`, `http_503`, and so on).
     * Known account faults may append a fixed application-owned code such as
     * `http_429_credit_balance_exhausted`; no provider message or participant
     * text is persisted.
     */
    readonly failureDetail: string = "",
  ) {
    super(`Feedback extraction failed: ${code}`);
    this.name = FeedbackExtractionGenerationError.name;
  }
}

/**
 * Structural provider incident. Never classified from error-message prose.
 * Conversation-local failures (filter, schema, validation) stay off this path.
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
 * Stub model id. Not a registered `AssistantModel` and unresolvable by
 * `resolveProviderModel`, so it cannot reach a provider.
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

export interface FeedbackReplyGenerationResult {
  readonly model: FeedbackExtractionModelId;
  readonly reply: string | null;
  readonly usage: FeedbackExtractionUsage;
  readonly estimatedPromptTokens: number;
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
  /**
   * Data-handling questions the batch asked. Read by the policy-answer append
   * and the unanswered-question raise — see `FeedbackAttentionClassificationResult`.
   */
  readonly policyQuestions: readonly FeedbackPolicyQuestionMatch[];
  readonly usage: FeedbackExtractionUsage;
  readonly estimatedPromptTokens: number;
}

/** Extractor model port. Real provider and rehearsal stub both implement it. */
export interface FeedbackExtractionModelPort {
  readonly model: FeedbackExtractionModelId;
  /**
   * Configured service tier, or undefined. On the port so a no-usage call still
   * costs at the right table.
   */
  readonly serviceTier: FeedbackExtractionServiceTier | undefined;
  propose(
    prompt: FeedbackExtractionPrompt,
    questionKeys: readonly FeedbackAnswerQuestionKey[],
  ): Promise<FeedbackExtractionGenerationResult>;
  rewriteReply(
    prompt: FeedbackExtractionPrompt,
    draft: string,
  ): Promise<FeedbackReplyGenerationResult>;
  classifyAttention(
    messages: readonly FeedbackExtractionMessageView[],
    targetMessageIds: readonly string[],
  ): Promise<FeedbackAttentionClassificationGenerationResult>;
}

/**
 * Extraction thinking budget. Not the assistant persisted enum. `xhigh`/`max`
 * take the raised output ceiling with every other non-`none` effort.
 */
export const FEEDBACK_EXTRACTION_REASONING_EFFORTS = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type FeedbackExtractionReasoningEffort =
  (typeof FEEDBACK_EXTRACTION_REASONING_EFFORTS)[number];

export const DEFAULT_FEEDBACK_REPLY_REASONING_EFFORT = "low" as const;

export function resolveFeedbackReplyReasoningEffort(
  configured: string | undefined,
): FeedbackExtractionReasoningEffort {
  if (!configured) {
    return DEFAULT_FEEDBACK_REPLY_REASONING_EFFORT;
  }
  const effort = FEEDBACK_EXTRACTION_REASONING_EFFORTS.find(
    (candidate) => candidate === configured,
  );
  if (!effort) {
    throw new Error(
      `FEEDBACK_REPLY_REASONING_EFFORT must be one of ${FEEDBACK_EXTRACTION_REASONING_EFFORTS.join(", ")}, received "${configured}"`,
    );
  }
  return effort;
}

/**
 * Unset omits the reasoning field (provider default). Sending `none` overrides
 * it. Unrecognised values fail at worker start.
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
 * OpenAI scheduling. `priority` is a per-token multiplier. Unset ≠ `auto`:
 * omit the field rather than send a second spelling of the account default.
 */
export const FEEDBACK_EXTRACTION_SERVICE_TIERS = [
  "default",
  "flex",
  "priority",
] as const;

export type FeedbackExtractionServiceTier =
  (typeof FEEDBACK_EXTRACTION_SERVICE_TIERS)[number];

/**
 * Unset omits the tier field (account default). Sending `default` overrides it.
 */
export function resolveFeedbackExtractionServiceTier(
  configured: string | undefined,
): FeedbackExtractionServiceTier | undefined {
  if (!configured) {
    return undefined;
  }
  const tier = FEEDBACK_EXTRACTION_SERVICE_TIERS.find(
    (candidate) => candidate === configured,
  );
  if (!tier) {
    throw new Error(
      `FEEDBACK_EXTRACTION_SERVICE_TIER must be one of ${FEEDBACK_EXTRACTION_SERVICE_TIERS.join(", ")}, received "${configured}"`,
    );
  }
  return tier;
}

/**
 * Provider-shaped reasoning + OpenAI-only service tier. Wrong-shaped options
 * are ignored (log would lie). Conditional spreads — do not serialise
 * `undefined`. Omit the whole block when neither applies.
 */
export function feedbackExtractionProviderOptions(
  model: AssistantModel,
  effort: FeedbackExtractionReasoningEffort | undefined,
  serviceTier: FeedbackExtractionServiceTier | undefined = undefined,
):
  | NonNullable<Parameters<typeof generateObject>[0]["providerOptions"]>
  | undefined {
  if (assistantModelAdapter(model).provider === "openai") {
    const openai = {
      ...(effort ? { reasoningEffort: effort } : {}),
      ...(serviceTier ? { serviceTier } : {}),
    };
    return Object.keys(openai).length > 0 ? { openai } : undefined;
  }
  return effort ? { openrouter: { reasoning: { effort } } } : undefined;
}

/** What a run with no thinking budget needs to emit one proposal. */
export const FEEDBACK_EXTRACTION_MAX_OUTPUT_TOKENS = 2_048;

/**
 * Output ceiling when thinking is enabled. Reasoning tokens share this budget;
 * 2048 at `xhigh` produced no object (`NoObjectGeneratedError`, retryable).
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
 * Classifier thinking ceiling — same number as extraction. A 1024 budget
 * vanishes into `xhigh` sooner.
 */
export const FEEDBACK_ATTENTION_CLASSIFICATION_THINKING_MAX_OUTPUT_TOKENS =
  FEEDBACK_EXTRACTION_THINKING_MAX_OUTPUT_TOKENS;

export function feedbackAttentionClassificationMaxOutputTokens(
  effort: FeedbackExtractionReasoningEffort | undefined,
): number {
  return effort && effort !== "none"
    ? FEEDBACK_ATTENTION_CLASSIFICATION_THINKING_MAX_OUTPUT_TOKENS
    : FEEDBACK_ATTENTION_CLASSIFICATION_MAX_OUTPUT_TOKENS;
}

/**
 * Classifier effort. Default is explicit `none` (not "field omitted") so a
 * 1024 ceiling is not left to an undeclared provider default. Thinking here
 * multiplies by campaign message volume.
 */
export const FEEDBACK_ATTENTION_DEFAULT_REASONING_EFFORT: FeedbackExtractionReasoningEffort =
  "none";

export function resolveFeedbackAttentionReasoningEffort(
  configured: string | undefined,
): FeedbackExtractionReasoningEffort {
  if (!configured) {
    return FEEDBACK_ATTENTION_DEFAULT_REASONING_EFFORT;
  }
  const effort = FEEDBACK_EXTRACTION_REASONING_EFFORTS.find(
    (candidate) => candidate === configured,
  );
  if (!effort) {
    throw new Error(
      `FEEDBACK_ATTENTION_REASONING_EFFORT must be one of ${FEEDBACK_EXTRACTION_REASONING_EFFORTS.join(", ")}, received "${configured}"`,
    );
  }
  return effort;
}

/** D12 default. Not an alias of the assistant default. */
export const FEEDBACK_EXTRACTION_DEFAULT_MODEL: AssistantModel =
  "google/gemini-3.6-flash";

export const FEEDBACK_SUMMARY_ONLY_MODEL: AssistantModel =
  "openai/gpt-5.6-terra";

/**
 * Registry-resolved extraction model. Unrecognised ids fail at worker start.
 * Terra is reserved for `FEEDBACK_SUMMARY_MODEL`.
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
  if (parsed.data === FEEDBACK_SUMMARY_ONLY_MODEL) {
    throw new Error(
      `FEEDBACK_EXTRACTION_MODEL cannot use ${FEEDBACK_SUMMARY_ONLY_MODEL}; Terra is reserved for FEEDBACK_SUMMARY_MODEL`,
    );
  }
  return parsed.data;
}

/**
 * Extraction provider boundary. Shared registry, no substitution on a missing
 * key. Output is a proposal until domain validation accepts it.
 */
@Injectable()
export class PostEventFeedbackExtractionModel implements FeedbackExtractionModelPort {
  private readonly logger = new Logger(PostEventFeedbackExtractionModel.name);
  private readonly openAiProvider: ReturnType<typeof createOpenAI> | undefined;
  private readonly openRouterProvider:
    ReturnType<typeof createOpenRouter> | undefined;
  readonly model: AssistantModel;
  readonly reasoningEffort: FeedbackExtractionReasoningEffort | undefined;
  readonly replyReasoningEffort: FeedbackExtractionReasoningEffort;
  readonly attentionReasoningEffort: FeedbackExtractionReasoningEffort;
  readonly serviceTier: FeedbackExtractionServiceTier | undefined;

  constructor(
    private readonly config: ConfigService<Environment, true>,
    private readonly providerCalls: ProviderCallLimiter = new ProviderCallLimiter(),
  ) {
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
    this.replyReasoningEffort = resolveFeedbackReplyReasoningEffort(
      this.config.get("FEEDBACK_REPLY_REASONING_EFFORT", { infer: true }),
    );
    this.attentionReasoningEffort = resolveFeedbackAttentionReasoningEffort(
      this.config.get("FEEDBACK_ATTENTION_REASONING_EFFORT", { infer: true }),
    );
    this.serviceTier = resolveFeedbackExtractionServiceTier(
      this.config.get("FEEDBACK_EXTRACTION_SERVICE_TIER", { infer: true }),
    );
  }

  async propose(
    prompt: FeedbackExtractionPrompt,
    questionKeys: readonly FeedbackAnswerQuestionKey[],
    beforeProviderCall?: FeedbackProviderCallGuard,
  ): Promise<FeedbackExtractionGenerationResult> {
    const model = this.resolveProviderModel(this.model);
    const proposalSchema = createFeedbackExtractionProposalSchema(questionKeys);
    const providerOptions = feedbackExtractionProviderOptions(
      this.model,
      this.reasoningEffort,
      this.serviceTier,
    );

    try {
      const result = await this.providerCalls.run(async () => {
        await beforeProviderCall?.();
        return generateObject({
          model,
          schema: proposalSchema,
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
      });

      return {
        model: this.model,
        proposal: proposalSchema.parse(result.object),
        usage: {
          inputTokens: result.usage.inputTokens ?? null,
          outputTokens: result.usage.outputTokens ?? null,
          totalTokens: result.usage.totalTokens ?? null,
        },
      };
    } catch (error) {
      if (error instanceof FeedbackProviderCallGuardError) throw error;
      throw toGenerationError(error);
    }
  }

  async classifyAttention(
    messages: readonly FeedbackExtractionMessageView[],
    targetMessageIds: readonly string[],
    beforeProviderCall?: FeedbackProviderCallGuard,
  ): Promise<FeedbackAttentionClassificationGenerationResult> {
    const model = this.resolveProviderModel(this.model);
    const batches = chunk(
      targetMessageIds,
      FEEDBACK_ATTENTION_CLASSIFICATION_BATCH_SIZE,
    );
    const signals: FeedbackExtractionSafetySignalProposal[] = [];
    const hostileMessageIds: string[] = [];
    const describedIncidentMessageIds: string[] = [];
    const policyQuestions: FeedbackPolicyQuestionMatch[] = [];
    const usages: FeedbackExtractionUsage[] = [];
    const providerOptions = feedbackExtractionProviderOptions(
      this.model,
      this.attentionReasoningEffort,
      this.serviceTier,
    );
    const maxOutputTokens = feedbackAttentionClassificationMaxOutputTokens(
      this.attentionReasoningEffort,
    );
    let estimatedPromptTokens = 0;

    try {
      for (const batch of batches) {
        const prompt = buildFeedbackAttentionClassificationPrompt({
          messages,
          targetMessageIds: batch,
        });
        estimatedPromptTokens += estimatePromptTokens(prompt);
        const result = await this.providerCalls.run(async () => {
          await beforeProviderCall?.();
          return generateObject({
            model,
            schema: feedbackAttentionClassificationProposalSchema,
            schemaName: "post_event_feedback_attention_classification",
            schemaDescription:
              "One contextual incident classification for every supplied participant message.",
            system: prompt.system,
            prompt: prompt.user,
            maxOutputTokens,
            maxRetries: 0,
            ...(providerOptions ? { providerOptions } : {}),
            abortSignal: AbortSignal.timeout(
              FEEDBACK_EXTRACTION_TIMEOUT_MILLISECONDS,
            ),
          });
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
        policyQuestions.push(...classified.policyQuestions);
        usages.push({
          inputTokens: result.usage.inputTokens ?? null,
          outputTokens: result.usage.outputTokens ?? null,
          totalTokens: result.usage.totalTokens ?? null,
        });
      }
    } catch (error) {
      if (error instanceof FeedbackProviderCallGuardError) throw error;
      throw toGenerationError(error);
    }

    return {
      model: this.model,
      signals,
      hostileMessageIds,
      describedIncidentMessageIds,
      policyQuestions,
      usage: combineFeedbackExtractionUsage(usages),
      estimatedPromptTokens,
    };
  }

  /**
   * Rewrite only text the application has already decided it may forward.
   *
   * Failure is deliberately fail-closed and does not retry the successful
   * extraction decision: answers and notes remain usable while this turn says
   * nothing. Retrying the whole job would pay for extraction again and is the
   * path that previously produced stale duplicate questions.
   */
  async rewriteReply(
    extractionPrompt: FeedbackExtractionPrompt,
    draft: string,
    beforeProviderCall?: FeedbackProviderCallGuard,
  ): Promise<FeedbackReplyGenerationResult> {
    const prompt = buildFeedbackReplyRewritePrompt({
      extractionPrompt,
      draft,
    });
    const estimatedPromptTokens = estimatePromptTokens(prompt);
    const model = this.resolveProviderModel(this.model);
    const providerOptions = feedbackExtractionProviderOptions(
      this.model,
      this.replyReasoningEffort,
      this.serviceTier,
    );

    try {
      const result = await this.providerCalls.run(async () => {
        await beforeProviderCall?.();
        return generateText({
          model,
          system: prompt.system,
          prompt: prompt.user,
          maxOutputTokens: 2_048,
          ...(providerOptions ? { providerOptions } : {}),
          maxRetries: 0,
          abortSignal: AbortSignal.timeout(
            FEEDBACK_EXTRACTION_TIMEOUT_MILLISECONDS,
          ),
        });
      });
      const reply = normalizeGeneratedReply(result.text);
      return {
        model: this.model,
        reply,
        usage: {
          inputTokens: result.usage.inputTokens ?? null,
          outputTokens: result.usage.outputTokens ?? null,
          totalTokens: result.usage.totalTokens ?? null,
        },
        estimatedPromptTokens,
      };
    } catch (error) {
      if (error instanceof FeedbackProviderCallGuardError) throw error;
      const mapped = toGenerationError(error);
      this.logger.warn({
        event: "feedback.reply_generation_failed",
        model: this.model,
        failure: {
          code: mapped.code,
          cause: mapped.failureCause,
          detail: mapped.failureDetail,
        },
      });
      return {
        model: this.model,
        reply: null,
        usage: {
          inputTokens: null,
          outputTokens: null,
          totalTokens: null,
        },
        estimatedPromptTokens,
      };
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
      // Extraction-only client: permissive safety cannot leak to the assistant.
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

function normalizeGeneratedReply(value: string): string | null {
  const reply = value
    .trim()
    .replace(/^["«'`]+|["»'`]+$/gu, "")
    .trim();
  return reply.length > 0 && reply.length <= 1_000 ? reply : null;
}

function chunk<T>(items: readonly T[], size: number): readonly T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}

/**
 * Component-wise usage sum. Null is absorbing — a missing component is not a
 * smaller bill.
 */
export function combineFeedbackExtractionUsage(
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
 * Map SDK errors to code + cause. Content-filter finish reasons are
 * `provider_refusal`; schema misses stay `validation_failed` and retryable.
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
    // Wrong shape is retryable. `content-filter` is a refusal — retrying repeats it.
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
 * Classify one HTTP failure from status/structured body, never from prose.
 * Retryability is the code; account fault vs refusal is the cause.
 */
function fromApiCallError(
  error: APICallError,
): FeedbackExtractionGenerationError {
  const accountFaultCode = feedbackProviderAccountFaultCode(error);
  const accountFault =
    accountFaultCode !== undefined ||
    (error.statusCode !== undefined &&
      FEEDBACK_PROVIDER_ACCOUNT_FAULT_STATUS_CODES.includes(error.statusCode));
  // OpenAI empty balance is 429 + structured quota codes — park, do not retry.
  const retryable = accountFault ? false : error.isRetryable;
  const statusDetail =
    error.statusCode === undefined ? "" : `http_${error.statusCode}`;
  return new FeedbackExtractionGenerationError(
    retryable ? "extraction_failed" : "provider_rejected",
    retryable,
    retryable || accountFault ? "provider_error" : "provider_refusal",
    accountFaultCode && statusDetail
      ? `${statusDetail}_${accountFaultCode}`
      : statusDetail,
  );
}

/**
 * Structured OpenAI empty-balance codes only. Status 429 is shared with TPM.
 */
function feedbackProviderAccountFaultCode(
  error: APICallError,
): "credit_balance_exhausted" | undefined {
  if (error.statusCode !== 429 || !error.responseBody) {
    return undefined;
  }
  try {
    const body: unknown = JSON.parse(error.responseBody);
    if (
      isRecord(body) &&
      isRecord(body.error) &&
      body.error.type === "insufficient_quota" &&
      body.error.code === "credit_balance_exhausted"
    ) {
      return "credit_balance_exhausted";
    }
  } catch {
    // An unparseable provider body still has its ordinary status treatment.
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Bounded unclassified-error detail: constructor name + short SDK/runtime
 * message. No participant text.
 */
function describeUnclassifiedError(error: unknown): string {
  const name = error instanceof Error ? error.constructor.name : typeof error;
  const message = error instanceof Error ? error.message : String(error);
  return `${name}: ${message}`.slice(0, 200);
}
