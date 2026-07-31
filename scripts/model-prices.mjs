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

/**
 * Sum token usage and USD cost across a run's conversation documents.
 *
 * Three states per conversation, and telling them apart is the whole job:
 *
 * - **`extraction.model` is null** — no run of this conversation ever called a
 *   model (a STOP before the first extraction, a participant who never wrote).
 *   Contributes nothing and blocks nothing: a conversation that was never
 *   billed does not make the bill unknowable. Run 12 printed
 *   `cost: unavailable` over five of these while every billed conversation had
 *   its tokens on record — the strict rule conflated "free" with "unrecorded".
 * - **model set, usage absent or a component null** — a model WAS called and
 *   the spend was not (fully) recorded: pre-ledger data, or a provider that
 *   never reported. The whole run's answer is null — "unavailable", never a
 *   number known to be missing a piece. A stub rehearsal lands here on
 *   purpose: its usage components are null, and "unavailable" beats a
 *   fictitious $0.00.
 * - **model set, usage complete** — sums tokens; the model's own price card
 *   (or its absence — OpenRouter models have none) decides whether the dollar
 *   total stays known.
 *
 * @param {ReadonlyArray<{
 *   extraction?: {
 *     model?: string | null,
 *     serviceTier?: string | null,
 *     usage?: {
 *       inputTokens: number | null,
 *       outputTokens: number | null,
 *       totalTokens: number | null,
 *     } | null,
 *   } | null,
 * }>} threads
 * @returns {{
 *   tokenUsage: { inputTokens: number, outputTokens: number } | null,
 *   costUsd: number | null,
 * }}
 */
export function summarizeThreadsCost(threads) {
  if (!Array.isArray(threads) || threads.length === 0) {
    return { tokenUsage: null, costUsd: null };
  }

  let inputTokens = 0;
  let outputTokens = 0;
  let costTotal = 0;
  let costKnown = true;
  let billedConversations = 0;

  for (const thread of threads) {
    const extraction = thread?.extraction;
    if (extraction?.model == null) {
      continue;
    }
    billedConversations += 1;

    const usage = extraction.usage;
    const inTokens = usage?.inputTokens;
    const outTokens = usage?.outputTokens;
    if (
      usage == null ||
      typeof inTokens !== "number" ||
      typeof outTokens !== "number" ||
      !Number.isFinite(inTokens) ||
      !Number.isFinite(outTokens)
    ) {
      return { tokenUsage: null, costUsd: null };
    }

    inputTokens += inTokens;
    outputTokens += outTokens;

    const part = costUsd({
      model: extraction.model,
      serviceTier: extraction.serviceTier,
      inputTokens: inTokens,
      outputTokens: outTokens,
    });
    if (part === null) {
      costKnown = false;
    } else {
      costTotal += part;
    }
  }

  // Nobody ever called a model: a genuinely free run, and $0.00 is its honest
  // price — distinct from the empty-input null above, which means "asked about
  // no conversations at all".
  if (billedConversations === 0) {
    return { tokenUsage: { inputTokens: 0, outputTokens: 0 }, costUsd: 0 };
  }

  return {
    tokenUsage: { inputTokens, outputTokens },
    costUsd: costKnown ? costTotal : null,
  };
}
