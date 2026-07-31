/**
 * Per-1M-token USD price card for models the burst rehearsal can bill directly.
 *
 * Prices read off the OpenAI pricing page on 2026-07-31. "priority" is OpenAI
 * fast mode; everything else (default / flex / unset) uses the standard rate.
 *
 * Models routed through OpenRouter (qwen, gemini, …) have no entry here on
 * purpose — `costUsd` returns null rather than inventing a number.
 */

/** @typedef {{ input: number, cachedInput: number, output: number }} TierPrices */
/** @typedef {{ standard: TierPrices, priority: TierPrices }} ModelPrice */

/** @type {Readonly<Record<string, ModelPrice>>} */
export const MODEL_PRICES = Object.freeze({
  "openai/gpt-5.6-luna": Object.freeze({
    standard: Object.freeze({
      input: 0.2,
      cachedInput: 0.02,
      output: 1.2,
    }),
    priority: Object.freeze({
      input: 0.4,
      cachedInput: 0.04,
      output: 2.4,
    }),
  }),
  "openai/gpt-5.6-terra": Object.freeze({
    standard: Object.freeze({
      input: 2.0,
      cachedInput: 0.2,
      output: 12.0,
    }),
    priority: Object.freeze({
      input: 4.0,
      cachedInput: 0.4,
      output: 24.0,
    }),
  }),
  "openai/gpt-5.6-sol": Object.freeze({
    standard: Object.freeze({
      input: 5.0,
      cachedInput: 0.5,
      output: 30.0,
    }),
    priority: Object.freeze({
      input: 10.0,
      cachedInput: 1.0,
      output: 60.0,
    }),
  }),
});

/**
 * USD cost for a single model call's token counts, or null when the card cannot
 * price it.
 *
 * We do not log the cached-token split, so every input token is charged at the
 * full `input` rate. That is a deliberate upper bound, not an exact invoice.
 *
 * @param {{
 *   model?: string | null,
 *   serviceTier?: string | null,
 *   inputTokens?: number | null,
 *   outputTokens?: number | null,
 * }} input
 * @returns {number | null}
 */
export function costUsd({ model, serviceTier, inputTokens, outputTokens }) {
  if (typeof model !== "string" || model.length === 0) {
    return null;
  }
  const prices = MODEL_PRICES[model];
  if (!prices) {
    return null;
  }
  if (
    typeof inputTokens !== "number" ||
    typeof outputTokens !== "number" ||
    !Number.isFinite(inputTokens) ||
    !Number.isFinite(outputTokens)
  ) {
    return null;
  }

  // Anything other than the explicit priority tier — undefined, null, "default",
  // "flex" — is the standard card.
  const tier = serviceTier === "priority" ? prices.priority : prices.standard;
  return (inputTokens * tier.input + outputTokens * tier.output) / 1_000_000;
}
