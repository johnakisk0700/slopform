import { APICallError } from "ai";

import type { AssistantModel } from "./assistant.schemas.js";

export type AssistantProvider = "openai" | "openrouter";

export interface AssistantModelAdapter {
  readonly provider: AssistantProvider;
  readonly providerModelId: string;
}

/**
 * The persisted/public id is intentionally separate from the provider id. This
 * table is the complete adapter boundary: changing providers never rewrites a
 * saved turn, and no model may silently substitute another model.
 *
 * Every entry is reached through OpenRouter, which is the only provider this
 * deployment holds credit with. The two OpenAI models used to name `openai`
 * here and it read as a routing choice; it was really an unfunded one. A 2026-07-27
 * rehearsal pointed extraction at `openai/gpt-5.6-luna` and every one of the
 * thirty-six extract jobs died on `provider_error` before a single token was
 * billed. OpenRouter serves the same two model ids verbatim, so the public ids
 * did not have to move — only the route under them.
 */
export const ASSISTANT_MODEL_ADAPTERS = {
  "openai/gpt-5.6-luna": {
    provider: "openrouter",
    providerModelId: "openai/gpt-5.6-luna",
  },
  "openai/gpt-5.6-terra": {
    provider: "openrouter",
    providerModelId: "openai/gpt-5.6-terra",
  },
  "google/gemini-3.6-flash": {
    provider: "openrouter",
    providerModelId: "google/gemini-3.6-flash",
  },
  "qwen/qwen3.7-max": {
    provider: "openrouter",
    providerModelId: "qwen/qwen3.7-max",
  },
} as const satisfies Record<AssistantModel, AssistantModelAdapter>;

export function assistantModelAdapter(
  model: AssistantModel,
): AssistantModelAdapter {
  return ASSISTANT_MODEL_ADAPTERS[model];
}

export function isRetryableProviderError(error: unknown): boolean {
  return !APICallError.isInstance(error) || error.isRetryable;
}
