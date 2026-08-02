import { APICallError } from "ai";

import type { AssistantModel } from "./assistant.schemas.js";

export type AssistantProvider = "openai" | "openrouter";

export interface AssistantModelAdapter {
  readonly provider: AssistantProvider;
  readonly providerModelId: string;
  /**
   * Whether this model may be offered the read-only tool set.
   *
   * A per-entry claim rather than a provider-wide assumption, and it is the
   * claim `apps/backend/src/cli/assistant-tools-smoke.ts` exists to check: a model that
   * cannot call tools answers from the conversation alone, visibly, instead of
   * having its request silently rerouted to one that can.
   */
  readonly supportsTools: boolean;
}

/**
 * The persisted/public id is intentionally separate from the provider id. This
 * table is the complete adapter boundary: changing providers never rewrites a
 * saved turn, and no model may silently substitute another model.
 *
 * The route is chosen per entry by the model contract, never by which account
 * happens to have credit today. Luna and Terra go through OpenAI direct so
 * their reasoning effort and service tier are explicit request parameters we
 * control. An OpenRouter model may later be added as a separate, explicit
 * fallback adapter; this table never performs silent provider fallback.
 *
 * Note the id shapes differ per provider and are not cosmetic: OpenRouter
 * addresses models as `vendor/model`, OpenAI wants the bare name. The Luna
 * public id below always means the direct-OpenAI adapter. A future OpenRouter
 * fallback needs its own public id so persisted turns keep telling the truth.
 */
export const ASSISTANT_MODEL_ADAPTERS = {
  "openai/gpt-5.6-luna": {
    provider: "openai",
    providerModelId: "gpt-5.6-luna",
    supportsTools: true,
  },
  "openai/gpt-5.6-terra": {
    provider: "openai",
    providerModelId: "gpt-5.6-terra",
    supportsTools: true,
  },
  "google/gemini-3.6-flash": {
    provider: "openrouter",
    providerModelId: "google/gemini-3.6-flash",
    supportsTools: true,
  },
  "qwen/qwen3.7-max": {
    provider: "openrouter",
    providerModelId: "qwen/qwen3.7-max",
    supportsTools: true,
  },
} as const satisfies Record<AssistantModel, AssistantModelAdapter>;

export function assistantModelAdapter(
  model: AssistantModel,
): AssistantModelAdapter {
  return ASSISTANT_MODEL_ADAPTERS[model];
}

/**
 * Whether the fast lane can be bought for this model at all.
 *
 * `service_tier` is an OpenAI request parameter; the OpenRouter route has no
 * equivalent and would ignore it. Asking here — rather than letting the request
 * carry a tier nobody honours — is what keeps a persisted turn repriceable from
 * its own row.
 */
export function assistantModelSupportsServiceTier(
  model: AssistantModel,
): boolean {
  return assistantModelAdapter(model).provider === "openai";
}

export function assistantModelSupportsTools(model: AssistantModel): boolean {
  return assistantModelAdapter(model).supportsTools;
}

export function isRetryableProviderError(error: unknown): boolean {
  return !APICallError.isInstance(error) || error.isRetryable;
}
