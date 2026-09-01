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
 * retryable half of a provider fault (a timeout, a rate-limit 429, a 503)
 * already reaches `provider_error` through `isRetryable`; these do not, and until this list
 * existed every one of them was classified `provider_refusal` — the class that
 * means a human should read the transcript. An exhausted OpenRouter balance
 * therefore looked identical to a content filter stopping on a disclosure, and
 * on 2026-07-27 thirty-six participants were told the analysis of their evening
 * had failed because of our billing.
 *
 * 401 is a wrong or missing key, 402 is out of credit, 403 is a forbidden route
 * or region, 404 is a model id the provider does not serve. OpenAI reports its
 * exhausted credit balance as a retryable 429, so `fromApiCallError` separately
 * recognises the provider's structured `credit_balance_exhausted` code. Every
 * one of these failures is identical for every conversation in the campaign and
 * none is repaired by reading a message — somebody must top up, fix the key or
 * correct the model id, after which the same request succeeds.
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
  /**
   * The tier these calls buy, `undefined` when they buy none.
   *
   * On the port rather than on the result because it is a property of how this
   * model is configured, not of any one generation — and because the run that
   * persists it needs it even when a call returned no usage at all. It is priced
   * downstream: `priority` is OpenAI's fast lane and costs more per token, so a
   * conversation that omitted it would be costed at the wrong table.
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
 * The thinking budget the extraction call may ask for, in both providers'
 * spellings.
 *
 * Deliberately not the assistant's `low | medium | high`. That enum is persisted
 * on every turn behind the `assistant_turns_effort_check` constraint; this one
 * is persisted nowhere, so widening it costs no migration. `xhigh` and `max`
 * are offered by OpenAI on Luna. The evaluation deliberately uses OpenAI direct
 * so this budget is an explicit request control under our provider contract,
 * not an assumed equivalent through an upstream router.
 *
 * `max` was added on 2026-07-31 after probing the responses API directly:
 * `reasoning: { effort: "max" }` on `gpt-5.6-luna` answered 200 rather than the
 * 400 an unknown effort earns. It is listed here on that evidence alone — the
 * table below was never re-measured at `max`, and there is no reason to expect it
 * to spend *less* than `xhigh` did, so it takes the raised ceiling with every
 * other thinking budget.
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
 * How hard OpenAI is asked to hurry, on the routes where asking is possible.
 *
 * `default` is standard scheduling, `flex` trades latency for a lower rate on
 * work nobody is waiting for, and **`priority` is OpenAI's paid fast lane at
 * roughly twice the standard token price** — a per-token multiplier on both
 * calls, not a flat fee, so it is left unset unless a rehearsal is being timed.
 *
 * The vocabulary is deliberately narrower than the SDK's, which also accepts
 * `auto`. `auto` means «let the account default decide», which is exactly what
 * leaving this unset already does, and having two spellings of the same thing
 * only invites a config that says one and means the other.
 */
export const FEEDBACK_EXTRACTION_SERVICE_TIERS = [
  "default",
  "flex",
  "priority",
] as const;

export type FeedbackExtractionServiceTier =
  (typeof FEEDBACK_EXTRACTION_SERVICE_TIERS)[number];

/**
 * Unset omits the field, which is not the same as sending `default`: omitting it
 * leaves the account's own tier in force, while `default` overrides whatever
 * that is. An unrecognised value throws at worker start for the reason every
 * other setting in this file does — a typo that silently degraded to «whatever
 * OpenAI felt like» would be discovered on the invoice.
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
 * One thinking budget and one service tier, spelled for whichever provider the
 * registry chose.
 *
 * The two SDKs disagree on the shape, and a body sent in the wrong one is not an
 * error — it is ignored, and the call quietly runs at the provider's default
 * effort while the log claims otherwise.
 *
 * The service tier is **OpenAI-only, by construction rather than by convention**.
 * There is no `serviceTier` on the OpenRouter provider options: OpenRouter does
 * its own routing between upstreams, so the key would ride along as an ignored
 * extra and every OpenRouter campaign would read as though it had bought the
 * fast lane. Dropping it here is the only place that can be guaranteed, because
 * this is the only function that builds the block.
 *
 * Both keys are conditional spreads rather than `key: undefined`, because
 * `exactOptionalPropertyTypes` is on and, more to the point, an explicit
 * `undefined` is still an own property and would be serialised into the request.
 * When neither applies the whole block is omitted, which is how a call that
 * configures nothing keeps sending no provider options at all.
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
 * The same ceiling the extraction call takes once it is allowed to think, and
 * for the same reason: reasoning tokens come out of this budget.
 *
 * It is an alias rather than a second number because there is no separate
 * measurement behind it. The one on record says a 2,048 budget vanished entirely
 * into `xhigh` thinking; a 1,024 budget would vanish sooner, and the classifier
 * would return nothing at all.
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
 * The thinking budget for the attention classifier, which **defaults to `none`
 * and is now configurable** through `FEEDBACK_ATTENTION_REASONING_EFFORT`.
 *
 * Until 2026-07-31 this was pinned: the classifier answers a bounded per-message
 * question, so reasoning looked like it bought nothing. Run 11 said otherwise.
 * The judgement the classifier actually gets wrong is *hostility* — whether a
 * message is aimed abusively at us or is a participant describing something that
 * happened to them — and that is not a lookup, it is exactly the kind of reading
 * a thinking budget helps with. The product decision that day was to make it
 * reachable, not to turn it on.
 *
 * **The cost warning stands, and it is the reason the default did not move.**
 * The extraction call runs once per extraction; the classifier runs once per
 * batch of messages, across every conversation in the campaign. Thinking here is
 * multiplied by the whole campaign's message volume, and it is charged whether
 * or not any message in the batch turned out to be interesting. Raise it for a
 * rehearsal you are reading afterwards, not for a live campaign, and expect the
 * bill to scale with participants rather than with runs.
 *
 * Note what the default `none` is *not*: it is not the extraction call's unset,
 * which sends no reasoning field and inherits the provider's own default. `none`
 * is sent explicitly, in the provider's own spelling, because leaving a 1,024
 * ceiling to a provider's undeclared default is how a batch reply gets truncated
 * with nobody able to say why. Setting the variable replaces that `none`; it
 * never returns the call to «field omitted».
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

/**
 * D12's default. It is deliberately its own constant rather than an alias of
 * the assistant default: the two features choose a model for different reasons,
 * and changing one must not silently change the other.
 */
export const FEEDBACK_EXTRACTION_DEFAULT_MODEL: AssistantModel =
  "google/gemini-3.6-flash";

export const FEEDBACK_SUMMARY_ONLY_MODEL: AssistantModel =
  "openai/gpt-5.6-terra";

/**
 * Resolves the configured extraction model against the shared provider
 * registry. An unrecognised id fails at worker start, because the alternative —
 * quietly using the default — would bill and log a model nobody asked for.
 * Terra is deliberately rejected here: feedback summaries own it through their
 * separate configuration, while participant-facing work uses another model.
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
 * The model boundary for feedback conversation extraction.
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
      // Scoped here on purpose: this provider instance serves
      // feedback extraction and nothing else, so permissive thresholds cannot
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
 * Adds usages component by component, with null absorbing.
 *
 * Exported because the extractor combines the same way across its two phases:
 * one run is an extraction call plus an attention call, and what gets persisted
 * is what the run as a whole cost. A component nobody reported must not read as
 * the sum of the parts that were.
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
  const accountFaultCode = feedbackProviderAccountFaultCode(error);
  const accountFault =
    accountFaultCode !== undefined ||
    (error.statusCode !== undefined &&
      FEEDBACK_PROVIDER_ACCOUNT_FAULT_STATUS_CODES.includes(error.statusCode));
  // AI SDK marks every HTTP 429 retryable. OpenAI also uses 429 when the credit
  // balance is empty, which no immediate retry can repair. Make that account
  // fault permanent for this BullMQ attempt so it parks immediately; the
  // durable five-minute park ladder remains responsible for recovery after a
  // top-up.
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
 * Returns only fixed, application-owned account-fault names.
 *
 * OpenAI's 2026-08-03 production response used HTTP 429 with
 * `type=insufficient_quota` and `code=credit_balance_exhausted`. Reading the
 * structured body is necessary because the status is shared with ordinary TPM
 * pressure; returning a fixed literal keeps provider prose out of logs.
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
