import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import {
  APICallError,
  NoContentGeneratedError,
  RetryError,
  generateText,
  stepCountIs,
  streamText,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
} from "ai";

import { ProviderCallLimiter } from "../../infrastructure/ai/provider-call-limiter.js";
import type { Environment } from "../../infrastructure/config/environment.js";
import {
  assistantContentSchema,
  type AssistantFailureCode,
  type AssistantModel,
  type AssistantReasoningEffort,
  type AssistantServiceTier,
  type AssistantToolCall,
  type AssistantUsage,
} from "./assistant.schemas.js";
import { priceAssistantUsage } from "./assistant-pricing.js";
import {
  assistantModelAdapter,
  assistantModelSupportsTools,
  isRetryableProviderError,
} from "./assistant-models.js";
import {
  assistantToolActivityLabel,
  AssistantToolsService,
  type AssistantToolActivity,
} from "./tools/assistant-tools.service.js";

const ASSISTANT_SYSTEM_PROMPT = `You are the Join The Six administrative assistant, answering staff questions about events, the people who attend them and their post-event feedback.

Answer clearly and concisely. Do not claim to have performed actions or accessed data that was not supplied in this conversation.

## Tools

You have read-only tools over the live database. Call them rather than guessing, and call current_datetime before answering anything that depends on today's date. You cannot change any data; if asked to, say so and describe where in the admin an operator can do it.

## Presentation

Ordinary answers are Markdown, and GitHub tables are the right shape for a list of people or events.

For a single person or a single event, prefer a card over prose — a fenced \`jts\` block holding one JSON object. Put the reading of the data in your sentences and the data itself in the card; do not repeat the fields in prose next to it.

\`\`\`jts
{"kind":"profile","name":"Maria K.","email":"maria@example.com","phone":"+3069...","neighborhood":"Koukaki","ageBand":"30-39","feedbackOptIn":true,"eventCount":4}
\`\`\`

\`\`\`jts
{"kind":"event","title":"Sunday Six","startsAt":"2026-08-09T18:00:00.000Z","status":"scheduled","venue":"Kafeneio","area":"Pagrati","attendeeCount":6,"presentCount":0}
\`\`\`

\`\`\`jts
{"kind":"conversation","respondent":"Maria K.","campaign":"Sunday Six","state":"open","control":"bot","needsAttention":true,"answered":2,"goalCount":4,"messageCount":11,"lastMessageAt":"2026-08-01T20:14:00.000Z"}
\`\`\`

Only \`kind\`, and the naming field — \`name\`, \`title\` or \`respondent\` — are required; leave a field out rather than guessing it. Every value in a card must come from a tool result: a card is read as fact, so an invented field is worse there than in a sentence.

A conversation card summarises; it never carries what was said. Quote testimony in the answer itself, as an ordinary Markdown quotation, so the reader can see it is a quotation.

You may also use \`\`\`chart\`\`\` blocks ({"type":"bar","title":"…","data":[{"label":"…","value":1}]}) and \`\`\`mermaid\`\`\` diagrams where they genuinely help. A chart may carry "max" for the top of the scale its values were measured on, so an average of 4.2 on a 1–5 rating draws as 4.2 of 5 rather than as a full bar.`;

/**
 * How many model calls one turn may spend on the tool loop.
 *
 * Each step is a paid round trip carrying every earlier tool result, so this is
 * a cost ceiling — but a deliberately generous one. Six was too mean in
 * practice: «which campaigns need a person, and what did those people say» is
 * an ordinary operator question that fans out across a list and then several
 * detail reads, and clipping it produced a worse answer to save a few cents on
 * a question somebody asked because they needed it answered. Ten is still a
 * hard stop against a model that has started looping.
 */
const ASSISTANT_MAX_STEPS = 10;
const ASSISTANT_MAX_TOOL_CALLS = 20;
const ASSISTANT_TOOL_INPUT_MAX_CHARACTERS = 512;
const ASSISTANT_TOOL_OUTPUT_MAX_CHARACTERS = 1_536;

/**
 * Forbids tools on the final permitted step, so the budget can never be spent
 * entirely on lookups.
 *
 * Found the hard way against Gemini 3.6 Flash: «which campaigns need a person,
 * and what did those people say» spent every step on tool calls, stopped on the
 * cap with no text, and the turn failed — twice, because an empty completion is
 * classified retryable, so the operator paid for the whole chain again before
 * seeing the same nothing.
 *
 * Raising the budget alone would not have fixed this; it would only have moved
 * the cliff. A reserved final step removes the cliff: whatever the budget, the
 * turn ends by answering from what it gathered rather than by erroring, and a
 * partial answer that says so beats an error every time.
 */
function reserveFinalStepForAnswering(options: {
  readonly stepNumber: number;
}): { readonly toolChoice: "none" } | undefined {
  return options.stepNumber === ASSISTANT_MAX_STEPS - 1
    ? { toolChoice: "none" }
    : undefined;
}

/**
 * Everything one streamed generation produced.
 *
 * `content` is the only authoritative part. `reasoning` is the provider's own
 * account of its thinking — a summary on the OpenAI route, live deltas through
 * OpenRouter — and is null when the provider returned none. `usage` is captured
 * here because it is the only moment it exists: the SDK reports it once, when
 * the stream finishes, and a turn that did not record it can never be priced.
 */
export interface AssistantGenerationResult {
  readonly content: string;
  readonly reasoning: string | null;
  readonly toolCalls: readonly AssistantToolActivity[];
  readonly usage: AssistantUsage;
}

export class AssistantGenerationError extends Error {
  constructor(
    readonly code: AssistantFailureCode,
    readonly retryable: boolean,
  ) {
    super("Assistant generation failed");
    this.name = AssistantGenerationError.name;
  }
}

@Injectable()
export class AssistantGenerationService {
  private readonly openAiProvider: ReturnType<typeof createOpenAI> | undefined;
  private readonly openRouterProvider:
    ReturnType<typeof createOpenRouter> | undefined;

  constructor(
    private readonly config: ConfigService<Environment, true>,
    private readonly tools: AssistantToolsService,
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
  }

  async generate(input: {
    readonly model: AssistantModel;
    readonly effort: AssistantReasoningEffort;
    readonly serviceTier: AssistantServiceTier;
    readonly messages: ModelMessage[];
  }): Promise<string> {
    let model: LanguageModel;

    try {
      model = this.resolveProviderModel(input.model);
    } catch (error) {
      if (error instanceof AssistantGenerationError) {
        throw error;
      }
      throw new AssistantGenerationError("provider_unavailable", false);
    }

    const tools = this.toolSetFor(input.model);

    try {
      const result = await this.providerCalls.run(() =>
        generateText({
          model,
          system: ASSISTANT_SYSTEM_PROMPT,
          messages: input.messages as ModelMessage[],
          ...(tools
            ? {
                tools,
                stopWhen: stepCountIs(ASSISTANT_MAX_STEPS),
                prepareStep: reserveFinalStepForAnswering,
              }
            : {}),
          maxOutputTokens: 4_096,
          maxRetries: 0,
          timeout: { totalMs: 120_000 },
          providerOptions: providerOptions(
            input.model,
            input.effort,
            input.serviceTier,
            tools !== undefined,
          ),
        }),
      );
      const response = result.text.trim();

      if (!response) {
        throw new AssistantGenerationError("generation_failed", true);
      }

      const persistedResponse = assistantContentSchema.safeParse(response);
      if (!persistedResponse.success) {
        throw new AssistantGenerationError("generation_failed", false);
      }

      return persistedResponse.data;
    } catch (error) {
      throw toGenerationError(error);
    }
  }

  /**
   * The streaming twin of `generate`. `onDelta` receives the text accumulated so
   * far, not the raw chunk, so a throttling caller can drop deltas freely and
   * still record a coherent prefix. The queue owns this generation, so the
   * stream is consumed to completion here — a reader that stops listening must
   * never abort work the turn is still accountable for.
   */
  async generateStreaming(input: {
    readonly model: AssistantModel;
    readonly effort: AssistantReasoningEffort;
    readonly serviceTier: AssistantServiceTier;
    readonly messages: ModelMessage[];
    readonly onDelta: (accumulated: string) => void;
    readonly onReasoningDelta?: (accumulated: string) => void;
    /**
     * One entry per tool call, emitted when the call starts and again when it
     * settles.
     *
     * Kept apart from `onReasoningDelta` on purpose. Reasoning is the model's
     * own account of itself; this is our record of what the turn actually did
     * to the database. Merging them would put our sentences inside a disclosure
     * labelled as the model's — and the two also differ in trustworthiness,
     * since a tool call either happened or it did not.
     */
    readonly onToolActivity?: (
      activity: readonly AssistantToolActivity[],
    ) => void;
  }): Promise<AssistantGenerationResult> {
    let model: LanguageModel;

    try {
      model = this.resolveProviderModel(input.model);
    } catch (error) {
      if (error instanceof AssistantGenerationError) {
        throw error;
      }
      throw new AssistantGenerationError("provider_unavailable", false);
    }

    const tools = this.toolSetFor(input.model);

    try {
      const response = await this.providerCalls.run(async () => {
        const result = streamText({
          model,
          system: ASSISTANT_SYSTEM_PROMPT,
          messages: input.messages as ModelMessage[],
          ...(tools
            ? {
                tools,
                stopWhen: stepCountIs(ASSISTANT_MAX_STEPS),
                prepareStep: reserveFinalStepForAnswering,
              }
            : {}),
          maxOutputTokens: 4_096,
          maxRetries: 0,
          timeout: { totalMs: 120_000 },
          providerOptions: providerOptions(
            input.model,
            input.effort,
            input.serviceTier,
            tools !== undefined,
          ),
        });

        // `fullStream`, not `textStream`: the latter is documented as text
        // deltas only, so reading it discards reasoning — and every tool part —
        // without a trace. Everything this turn is accountable for arrives here.
        let text = "";
        let reasoning = "";
        const activity: AssistantToolActivity[] = [];
        for await (const part of result.fullStream) {
          if (part.type === "text-delta") {
            text += part.text;
            input.onDelta(text);
            continue;
          }
          if (part.type === "reasoning-delta") {
            reasoning += part.text;
            input.onReasoningDelta?.(reasoning);
            continue;
          }
          // The whole accumulated list goes out each time, matching how text and
          // reasoning are published: a reader may drop any frame and still hold
          // a coherent picture from the next one.
          if (part.type === "tool-call") {
            if (activity.length >= ASSISTANT_MAX_TOOL_CALLS) continue;
            const boundedInput = boundedToolPayload(
              part.input,
              ASSISTANT_TOOL_INPUT_MAX_CHARACTERS,
            );
            activity.push({
              toolCallId: part.toolCallId,
              tool: part.toolName,
              label: assistantToolActivityLabel(part.toolName),
              state: "running",
              input: boundedInput.value,
              output: null,
              inputTruncated: boundedInput.truncated,
              outputTruncated: false,
            });
            input.onToolActivity?.([...activity]);
            continue;
          }
          if (part.type === "tool-result" || part.type === "tool-error") {
            const entry = activity.find(
              (candidate) => candidate.toolCallId === part.toolCallId,
            );
            if (entry) {
              entry.state = part.type === "tool-result" ? "done" : "failed";
              if (part.type === "tool-result") {
                const boundedOutput = boundedToolPayload(
                  part.output,
                  ASSISTANT_TOOL_OUTPUT_MAX_CHARACTERS,
                );
                entry.output = boundedOutput.value;
                entry.outputTruncated = boundedOutput.truncated;
              }
              input.onToolActivity?.([...activity]);
            }
          }
        }

        return {
          text: text.trim(),
          reasoning,
          toolCalls: activity,
          usage: await result.usage,
        };
      });

      if (!response.text) {
        throw new AssistantGenerationError("generation_failed", true);
      }

      const persistedResponse = assistantContentSchema.safeParse(response.text);
      if (!persistedResponse.success) {
        throw new AssistantGenerationError("generation_failed", false);
      }

      return {
        content: persistedResponse.data,
        reasoning: response.reasoning.trim() || null,
        toolCalls: response.toolCalls,
        usage: priceAssistantUsage(input.model, input.serviceTier, {
          inputTokens: response.usage.inputTokens ?? null,
          outputTokens: response.usage.outputTokens ?? null,
          reasoningTokens:
            response.usage.outputTokenDetails?.reasoningTokens ?? null,
          cachedInputTokens:
            response.usage.inputTokenDetails?.cacheReadTokens ?? null,
          totalTokens: response.usage.totalTokens ?? null,
        }),
      };
    } catch (error) {
      throw toGenerationError(error);
    }
  }

  /**
   * The tool set this model may use, or `undefined` when it may not.
   *
   * Read-only tools carry no per-operator scoping because there is none to
   * carry: the guard admits one role, so every authenticated caller already
   * sees every row through the admin API. What the flag protects is honesty
   * about capability — a model that cannot call tools answers from the
   * conversation alone rather than being quietly swapped for one that can.
   */
  private toolSetFor(model: AssistantModel): ToolSet | undefined {
    return assistantModelSupportsTools(model)
      ? this.tools.toolSet()
      : undefined;
  }

  private resolveProviderModel(model: AssistantModel): LanguageModel {
    const adapter = assistantModelAdapter(model);

    if (adapter.provider === "openrouter") {
      if (!this.openRouterProvider) {
        throw new AssistantGenerationError("provider_unavailable", false);
      }
      return this.openRouterProvider(adapter.providerModelId);
    }

    if (!this.openAiProvider) {
      throw new AssistantGenerationError("provider_unavailable", false);
    }
    return this.openAiProvider(adapter.providerModelId);
  }
}

function boundedToolPayload(
  value: unknown,
  maximumCharacters: number,
): {
  readonly value: AssistantToolCall["input"];
  readonly truncated: boolean;
} {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) return { value: null, truncated: false };
    if (serialized.length <= maximumCharacters) {
      return {
        value: JSON.parse(serialized) as AssistantToolCall["input"],
        truncated: false,
      };
    }
    return {
      value: {
        preview: serialized.slice(0, maximumCharacters),
        originalCharacters: serialized.length,
      },
      truncated: true,
    };
  } catch {
    return {
      value: { preview: "Tool payload could not be serialized" },
      truncated: true,
    };
  }
}

/**
 * Reasoning effort in each provider's spelling, plus the service tier where one
 * can be bought.
 *
 * `service_tier` is an OpenAI parameter with no OpenRouter equivalent, so the
 * OpenRouter branch omits it entirely rather than sending a field that route
 * would ignore. The caller has already normalised the tier to `standard` for
 * those models, so the two agree by construction, but sending it here anyway
 * would make a silently-dropped surcharge look purchased.
 */
function providerOptions(
  model: AssistantModel,
  effort: AssistantReasoningEffort,
  serviceTier: AssistantServiceTier,
  withTools: boolean,
): NonNullable<Parameters<typeof generateText>[0]["providerOptions"]> {
  if (assistantModelAdapter(model).provider !== "openai") {
    return {
      openrouter: {
        reasoning: { effort },
        // OpenRouter serves one model id from several upstream providers, and
        // it drops parameters the chosen route cannot honour rather than
        // failing. A route that silently ignored `tools` would answer from the
        // conversation alone while the turn believed it had searched the
        // database, so a tool-bearing request pins routing to providers that
        // accept what it sent.
        ...(withTools ? { provider: { require_parameters: true } } : {}),
      },
    };
  }

  return {
    openai: {
      reasoningEffort: effort,
      // OpenAI renamed this tier "fast" on 2026-07-30 and accepts either
      // spelling, but `@ai-sdk/openai@4.0.18` still types only `priority`. Our
      // vocabulary follows the current name and the adapter translates, which is
      // the same boundary that keeps public model ids off provider model ids.
      ...(serviceTier === "fast" ? { serviceTier: "priority" as const } : {}),
    },
  };
}

/** One provider-error taxonomy for both the buffered and the streaming call. */
function toGenerationError(error: unknown): AssistantGenerationError {
  if (error instanceof AssistantGenerationError) {
    return error;
  }

  if (APICallError.isInstance(error)) {
    return new AssistantGenerationError(
      error.isRetryable ? "generation_failed" : "provider_rejected",
      error.isRetryable,
    );
  }

  if (RetryError.isInstance(error)) {
    return new AssistantGenerationError(
      retryableCause(error.lastError),
      isRetryableProviderError(error.lastError),
    );
  }

  if (NoContentGeneratedError.isInstance(error)) {
    return new AssistantGenerationError("generation_failed", true);
  }

  return new AssistantGenerationError("generation_failed", true);
}

function retryableCause(error: unknown): AssistantFailureCode {
  return isRetryableProviderError(error)
    ? "generation_failed"
    : "provider_rejected";
}
