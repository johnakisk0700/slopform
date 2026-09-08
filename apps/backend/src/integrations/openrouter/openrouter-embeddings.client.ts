import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { z } from "zod";
import type { Environment } from "../../infrastructure/config/environment.js";

export class EmbeddingProviderFailure extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(code);
    this.name = "EmbeddingProviderFailure";
  }
}

const responseSchema = z.object({
  model: z.string().min(1),
  data: z
    .array(
      z.object({
        index: z.number().int().nonnegative(),
        embedding: z.array(z.number().finite()).max(4096),
      }),
    )
    .min(1)
    .max(32),
  usage: z.object({
    prompt_tokens: z.number().int().nonnegative().max(1_000_000),
    cost: z.number().finite().nonnegative().optional(),
  }),
});

@Injectable()
export class OpenRouterEmbeddingsClient {
  constructor(private readonly config: ConfigService<Environment, true>) {}

  async embed(
    input: {
      texts: string[];
      model: string;
      dimensions: number;
      provider: {
        readonly sort: string;
        readonly allow_fallbacks: boolean;
        readonly require_parameters: boolean;
        readonly max_price: {
          readonly prompt: number;
          readonly request: number;
        };
      };
    },
    signal: AbortSignal,
  ) {
    const apiKey = this.config.get("OPENROUTER_API_KEY", { infer: true });
    if (!apiKey)
      throw new EmbeddingProviderFailure("embedding_key_missing", false);
    if (
      !input.texts.length ||
      input.texts.length > 32 ||
      input.texts.some((text) => Buffer.byteLength(text, "utf8") > 4096)
    )
      throw new EmbeddingProviderFailure("embedding_input_invalid", false);
    const requestSignal = AbortSignal.any([
      signal,
      AbortSignal.timeout(30_000),
    ]);
    let response: Response;
    try {
      response = await fetch("https://openrouter.ai/api/v1/embeddings", {
        method: "POST",
        redirect: "error",
        signal: requestSignal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: input.model,
          dimensions: input.dimensions,
          encoding_format: "float",
          input: input.texts,
          provider: input.provider,
        }),
      });
    } catch {
      throw new EmbeddingProviderFailure("embedding_network_failed", true);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new EmbeddingProviderFailure(
        `embedding_http_${response.status}`,
        [408, 429].includes(response.status) || response.status >= 500,
      );
    }
    try {
      const parsed = responseSchema.safeParse(
        JSON.parse(await readBoundedResponse(response, 2 * 1024 * 1024)),
      );
      if (!parsed.success)
        throw new EmbeddingProviderFailure("embedding_response_invalid", false);
      const value = parsed.data;
      if (value.model.toLowerCase() !== input.model.toLowerCase())
        throw new EmbeddingProviderFailure("embedding_model_mismatch", false);
      if (value.data.length !== input.texts.length)
        throw new EmbeddingProviderFailure("embedding_coverage_invalid", false);
      const vectors: number[][] = [];
      for (const row of value.data) {
        if (
          row.index >= input.texts.length ||
          vectors[row.index] ||
          row.embedding.length !== input.dimensions ||
          !row.embedding.some((number) => number !== 0)
        )
          throw new EmbeddingProviderFailure(
            "embedding_vectors_invalid",
            false,
          );
        vectors[row.index] = row.embedding;
      }
      return {
        vectors,
        usage: {
          promptTokens: value.usage.prompt_tokens,
          costUsd: value.usage.cost ?? null,
        },
      };
    } catch (error) {
      if (error instanceof EmbeddingProviderFailure) throw error;
      throw new EmbeddingProviderFailure(
        requestSignal.aborted
          ? "embedding_response_timeout"
          : "embedding_response_invalid",
        requestSignal.aborted,
      );
    }
  }
}

async function readBoundedResponse(
  response: Response,
  limit: number,
): Promise<string> {
  if (!response.body)
    throw new EmbeddingProviderFailure("embedding_response_empty", false);
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > limit)
        throw new EmbeddingProviderFailure(
          "embedding_response_too_large",
          false,
        );
      parts.push(part.value);
    }
    return Buffer.concat(parts).toString("utf8");
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
