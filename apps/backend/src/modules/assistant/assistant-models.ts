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
 * The route is chosen per entry by **which account is funded**, never by which
 * name reads better. A 2026-07-27 rehearsal pointed extraction at
 * `openai/gpt-5.6-luna` while the OpenAI account was empty, and every one of the
 * thirty-six extract jobs died on `provider_error` before a single token was
 * billed; the whole table moved to OpenRouter that day. On 2026-07-31 the OpenAI
 * account was funded, so Luna goes direct — which also buys the `xhigh`
 * reasoning effort OpenRouter does not expose on this model.
 *
 * Note the id shapes differ per provider and are not cosmetic: OpenRouter
 * addresses models as `vendor/model`, OpenAI wants the bare name. The public id
 * stays `openai/gpt-5.6-luna` either way, so nothing already persisted moves.
 */
export const ASSISTANT_MODEL_ADAPTERS = {
  "openai/gpt-5.6-luna": {
    provider: "openai",
    providerModelId: "gpt-5.6-luna",
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
