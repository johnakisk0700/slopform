/**
 * Specs for the burst rehearsal price card.
 *
 * `node:test` rather than vitest, for the reason given at the top of
 * `scripts/burst-report.spec.mjs`: `scripts/` is outside every workspace, so
 * `turbo run test` never reaches it and vitest is not resolvable here.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { costUsd } from "./model-prices.mjs";

describe("costUsd", () => {
  it("prices luna at the standard rate", () => {
    // 1M in + 1M out → 0.20 + 1.20
    assert.equal(
      costUsd({
        model: "openai/gpt-5.6-luna",
        serviceTier: "default",
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
      }),
      1.4,
    );
  });

  it("prices luna at the priority rate", () => {
    // 1M in + 1M out → 0.40 + 2.40
    assert.equal(
      costUsd({
        model: "openai/gpt-5.6-luna",
        serviceTier: "priority",
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
      }),
      2.8,
    );
  });

  it("prices terra at the standard rate", () => {
    // 500k in + 100k out → 1.00 + 1.20
    assert.equal(
      costUsd({
        model: "openai/gpt-5.6-terra",
        inputTokens: 500_000,
        outputTokens: 100_000,
      }),
      2.2,
    );
  });

  it("returns null for a model with no card", () => {
    assert.equal(
      costUsd({
        model: "qwen/qwen3.7-max",
        inputTokens: 1_000,
        outputTokens: 1_000,
      }),
      null,
    );
  });

  it("returns null when token counts are missing", () => {
    assert.equal(
      costUsd({
        model: "openai/gpt-5.6-luna",
        inputTokens: 1_000,
      }),
      null,
    );
    assert.equal(
      costUsd({
        model: "openai/gpt-5.6-luna",
        inputTokens: Number.NaN,
        outputTokens: 1_000,
      }),
      null,
    );
  });
});
