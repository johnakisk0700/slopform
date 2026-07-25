import type { AssistantModelAdapter } from "../assistant/assistant-models.js";

/**
 * Permissive provider safety thresholds for the extraction call path only.
 *
 * The pipeline's job is to *record* what a participant said, including the ugly
 * parts. A provider-side content filter that refuses to emit structured output
 * does not make the disclosure go away — it makes it invisible: the job fails,
 * nothing is written, and the conversation stalls with no note and no operator
 * signal. That is strictly worse than reading the report, which is why these
 * thresholds are relaxed here.
 *
 * Scope matters. This is applied by
 * [`PostEventFeedbackExtractionModel`](./post-event-feedback-extraction.service.ts)
 * to the model instance it builds for `feedback.extract.v1`, and to nothing
 * else. The assistant feature constructs its own provider clients from the same
 * registry and is untouched, so relaxing extraction cannot relax a chat surface
 * a participant or staff member talks to.
 *
 * Relaxing the provider filter does **not** relax the domain: the proposal is
 * still Zod-validated, still bound by the D16 subject rules and the D18
 * degradation, and still cannot send anything by itself.
 */

/**
 * Gemini's documented category vocabulary. The registry maps `google/*` to
 * OpenRouter, which forwards unrecognised body fields to the upstream provider,
 * so this rides on the OpenRouter chat model's `extraBody` passthrough as
 * `safety_settings`.
 *
 * `BLOCK_NONE` is the widest documented threshold; the provider may still stop
 * on its own non-configurable policy, which is exactly the case the WP5
 * deterministic fallback exists to absorb.
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
 * Only Google models carry `safety_settings`; sending it to an unrelated
 * provider would be noise at best and a rejected request at worst, so the
 * passthrough is keyed on the resolved provider model id rather than applied
 * blindly to every extraction call.
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
