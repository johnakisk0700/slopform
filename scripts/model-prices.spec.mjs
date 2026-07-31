/**
 * Specs for the burst rehearsal price card.
 *
 * `node:test` rather than vitest, for the reason given at the top of
 * `scripts/burst-report.spec.mjs`: `scripts/` is outside every workspace, so
 * `turbo run test` never reaches it and vitest is not resolvable here.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { costUsd, summarizeThreadsCost } from "./model-prices.mjs";

const billed = (tokens, overrides = {}) => ({
  extraction: {
    model: "openai/gpt-5.6-luna",
    serviceTier: "priority",
    usage: {
      inputTokens: tokens,
      outputTokens: tokens,
      totalTokens: tokens * 2,
    },
    ...overrides,
  },
});

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

describe("summarizeThreadsCost", () => {
  it("sums billed conversations and prices them per their own tier", () => {
    const result = summarizeThreadsCost([
      billed(1_000_000),
      billed(1_000_000, { serviceTier: null }),
    ]);
    assert.deepEqual(result.tokenUsage, {
      inputTokens: 2_000_000,
      outputTokens: 2_000_000,
    });
    // priority (0.40 + 2.40) + standard (0.20 + 1.20). Compared with a
    // tolerance: two float additions, not an invoice to the exact cent.
    assert.ok(Math.abs(result.costUsd - 4.2) < 1e-9, String(result.costUsd));
  });

  it("lets a conversation that never called a model contribute nothing — and block nothing", () => {
    // The run 12 shape: five STOP-before-extraction conversations made the
    // whole bill "unavailable" while every billed conversation had its tokens
    // on record. Free is not unrecorded.
    const result = summarizeThreadsCost([
      billed(1_000_000),
      { extraction: { model: null, serviceTier: null, usage: null } },
    ]);
    assert.deepEqual(result.tokenUsage, {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    assert.equal(result.costUsd, 2.8);
  });

  it("still reports unavailable when a billed conversation has no recorded spend", () => {
    const result = summarizeThreadsCost([
      billed(1_000_000),
      { extraction: { model: "openai/gpt-5.6-luna", usage: null } },
    ]);
    assert.equal(result.tokenUsage, null);
    assert.equal(result.costUsd, null);
  });

  it("keeps a stub rehearsal unavailable rather than a fictitious zero", () => {
    const result = summarizeThreadsCost([
      {
        extraction: {
          model: "stub/burst-rehearsal",
          usage: { inputTokens: null, outputTokens: null, totalTokens: null },
        },
      },
    ]);
    assert.equal(result.costUsd, null);
  });

  it("prices a run where nobody ever called a model as genuinely free", () => {
    const result = summarizeThreadsCost([
      { extraction: { model: null, usage: null } },
    ]);
    assert.deepEqual(result.tokenUsage, { inputTokens: 0, outputTokens: 0 });
    assert.equal(result.costUsd, 0);
  });

  it("sums tokens but surrenders the dollar total on an unpriced model", () => {
    const result = summarizeThreadsCost([
      billed(1_000_000),
      billed(1_000, { model: "qwen/qwen3.7-max" }),
    ]);
    assert.deepEqual(result.tokenUsage, {
      inputTokens: 1_001_000,
      outputTokens: 1_001_000,
    });
    assert.equal(result.costUsd, null);
  });

  it("answers null when asked about no conversations at all", () => {
    assert.deepEqual(summarizeThreadsCost([]), {
      tokenUsage: null,
      costUsd: null,
    });
  });
});
