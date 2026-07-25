import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import {
  APICallError,
  NoContentGeneratedError,
  RetryError,
  generateText,
  type LanguageModel,
  type ModelMessage,
} from "ai";

import type { Environment } from "../../infrastructure/config/environment.js";
import type {
  AssistantFailureCode,
  AssistantModel,
  AssistantReasoningEffort,
} from "./assistant.schemas.js";
import { assistantModelAdapter } from "./assistant-models.js";

const ASSISTANT_SYSTEM_PROMPT =
  "You are the Join The Six administrative assistant. Answer clearly and concisely. Do not claim to have performed actions or accessed data that was not supplied in this conversation.";

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
  }

  async generate(input: {
    readonly model: AssistantModel;
    readonly effort: AssistantReasoningEffort;
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

    try {
      const result = await generateText({
        model,
        system: ASSISTANT_SYSTEM_PROMPT,
        messages: input.messages as ModelMessage[],
        maxOutputTokens: 4_096,
        maxRetries: 0,
        timeout: { totalMs: 120_000 },
        providerOptions: reasoningProviderOptions(input.model, input.effort),
      });
      const response = result.text.trim();

      if (!response) {
        throw new AssistantGenerationError("generation_failed", true);
      }

      return response;
    } catch (error) {
      if (error instanceof AssistantGenerationError) {
        throw error;
      }

      if (APICallError.isInstance(error)) {
        throw new AssistantGenerationError(
          error.isRetryable ? "generation_failed" : "provider_rejected",
          error.isRetryable,
        );
      }

      if (RetryError.isInstance(error)) {
        throw new AssistantGenerationError(
          retryableCause(error.lastError),
          isRetryableCause(error.lastError),
        );
      }

      if (NoContentGeneratedError.isInstance(error)) {
        throw new AssistantGenerationError("generation_failed", true);
      }

      throw new AssistantGenerationError("generation_failed", true);
    }
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

export function reasoningProviderOptions(
  model: AssistantModel,
  effort: AssistantReasoningEffort,
): NonNullable<Parameters<typeof generateText>[0]["providerOptions"]> {
  return assistantModelAdapter(model).provider === "openai"
    ? { openai: { reasoningEffort: effort } }
    : { openrouter: { reasoning: { effort } } };
}

function isRetryableCause(error: unknown): boolean {
  return !APICallError.isInstance(error) || error.isRetryable;
}

function retryableCause(error: unknown): AssistantFailureCode {
  return isRetryableCause(error) ? "generation_failed" : "provider_rejected";
}
