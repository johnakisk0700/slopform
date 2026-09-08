import { ConfigService } from "@nestjs/config";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Environment } from "../../infrastructure/config/environment.js";
import { OpenRouterEmbeddingsClient } from "./openrouter-embeddings.client.js";

const model = "qwen/qwen3-embedding-8b";
const input = {
  texts: ["synthetic one", "synthetic two"],
  model,
  dimensions: 1024,
  provider: {
    sort: "price",
    allow_fallbacks: false,
    require_parameters: true,
    max_price: { prompt: 0.01, request: 0 },
  },
};
const vector = Array.from({ length: 1024 }, () => 0.123);
const client = () =>
  new OpenRouterEmbeddingsClient(
    new ConfigService<Environment, true>({ OPENROUTER_API_KEY: "test-key" }),
  );
const response = (overrides: Record<string, unknown> = {}) => ({
  model,
  data: [
    { index: 1, embedding: vector },
    { index: 0, embedding: vector },
  ],
  usage: { prompt_tokens: 7, cost: 0.00000007 },
  ...overrides,
});
afterEach(() => vi.unstubAllGlobals());

describe("OpenRouter embeddings boundary", () => {
  it("sends fixed cost/routing/dimensions once and orders vectors by provider index", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(response()));
    vi.stubGlobal("fetch", fetcher);
    const result = await client().embed(input, new AbortController().signal);
    expect(result).toMatchObject({
      vectors: [vector, vector],
      usage: { promptTokens: 7, costUsd: 0.00000007 },
    });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(JSON.parse(fetcher.mock.calls[0]![1].body)).toMatchObject({
      model,
      dimensions: 1024,
      encoding_format: "float",
      provider: input.provider,
      input: input.texts,
    });
  });
  it.each([
    response({ model: "different-model" }),
    response({ data: [{ index: 0, embedding: vector }] }),
    response({
      data: [
        { index: 0, embedding: vector },
        { index: 0, embedding: vector },
      ],
    }),
    response({
      data: [
        { index: 0, embedding: [1] },
        { index: 1, embedding: vector },
      ],
    }),
    response({ usage: {} }),
  ])("rejects incomplete or mismatched provider results", async (value) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(value)));
    await expect(
      client().embed(input, new AbortController().signal),
    ).rejects.toMatchObject({ retryable: false });
  });
  it.each([
    [401, false],
    [402, false],
    [404, false],
    [429, true],
    [503, true],
  ])(
    "classifies HTTP %i without retaining provider body",
    async (status, retryable) => {
      const fetcher = vi
        .fn()
        .mockResolvedValue(
          new Response("private-provider-diagnostic", { status }),
        );
      vi.stubGlobal("fetch", fetcher);
      await expect(
        client().embed(input, new AbortController().signal),
      ).rejects.toMatchObject({ code: `embedding_http_${status}`, retryable });
      expect(fetcher).toHaveBeenCalledOnce();
    },
  );
  it("bounds response bytes and treats missing cost as unknown", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response("x".repeat(2 * 1024 * 1024 + 1)))
        .mockResolvedValueOnce(
          Response.json(response({ usage: { prompt_tokens: 7 } })),
        ),
    );
    await expect(
      client().embed(input, new AbortController().signal),
    ).rejects.toMatchObject({
      code: "embedding_response_too_large",
      retryable: false,
    });
    await expect(
      client().embed(input, new AbortController().signal),
    ).resolves.toMatchObject({ usage: { costUsd: null } });
  });
});
