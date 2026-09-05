import type { AssistantModelAdapter } from "../../assistant/assistant-models.js";

/**
 * Permissive provider safety thresholds for the extraction call path only.
 *
 * A provider filter that refuses structured output hides the disclosure: the
 * job fails with no note and no operator signal. Applied only to the extraction
 * model instance; the assistant builds its own clients from the same registry.
 * Domain validation (Zod, D16, D18) and send authority are unchanged.
 */

/**
 * Gemini categories via OpenRouter `extraBody.safety_settings`. `BLOCK_NONE` is
 * the widest documented threshold; a remaining provider refusal is absorbed by
 * the deterministic fallback.
 */
export const FEEDBACK_EXTRACTION_PERMISSIVE_SAFETY_SETTINGS = [
  { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
] as const;

export interface FeedbackExtractionProviderSettings {
  readonly extraBody: Record<string, unknown>;
}

/**
 * Only Google-via-OpenRouter models accept `safety_settings`; keyed on the
 * resolved provider model id so other routes are not rejected for noise.
 */
export function resolveFeedbackExtractionProviderSettings(
  adapter: AssistantModelAdapter,
): FeedbackExtractionProviderSettings | undefined {
  if (
    adapter.provider !== "openrouter" ||
    !adapter.providerModelId.startsWith("google/")
  ) {
    return undefined;
  }

  return {
    extraBody: {
      safety_settings: FEEDBACK_EXTRACTION_PERMISSIVE_SAFETY_SETTINGS.map(
        (setting) => ({ ...setting }),
      ),
    },
  };
}
