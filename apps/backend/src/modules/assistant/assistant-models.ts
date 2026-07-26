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
 */
export const ASSISTANT_MODEL_ADAPTERS = {
  "openai/gpt-5.6-luna": {
    provider: "openai",
    providerModelId: "gpt-5.6-luna",
  },
  "openai/gpt-5.6-terra": {
    provider: "openai",
    providerModelId: "gpt-5.6-terra",
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
