import type { ConfigService } from "@nestjs/config";
import { APICallError, generateText } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Environment } from "../../infrastructure/config/environment.js";
import {
  AssistantGenerationError,
  AssistantGenerationService,
} from "./assistant-generation.service.js";

vi.mock("ai", async (importOriginal) => {
  const original = await importOriginal<typeof import("ai")>();
  return { ...original, generateText: vi.fn() };
});

const mockedGenerateText = vi.mocked(generateText);

function createService(keys: {
  readonly openAi?: string;
  readonly openRouter?: string;
}): AssistantGenerationService {
  const values = {
    OPENAI_API_KEY: keys.openAi,
    OPENROUTER_API_KEY: keys.openRouter,
  };
  const config = {
    get: vi.fn((key: keyof typeof values) => values[key]),
  } as unknown as ConfigService<Environment, true>;
  return new AssistantGenerationService(config);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AssistantGenerationService", () => {
  it("calls Gemini through OpenRouter without tools or hidden SDK retries", async () => {
    mockedGenerateText.mockResolvedValue({
      text: "  Hello from Gemini  ",
    } as Awaited<ReturnType<typeof generateText>>);
    const service = createService({ openRouter: "router-key" });

    await expect(
      service.generate({
        model: "google/gemini-3.6-flash",
        effort: "high",
        messages: [{ role: "user", content: "Hello" }],
      }),
    ).resolves.toBe("Hello from Gemini");

    expect(mockedGenerateText).toHaveBeenCalledOnce();
    const options = mockedGenerateText.mock.calls[0]?.[0];
    expect(options).toMatchObject({
      maxOutputTokens: 4_096,
      maxRetries: 0,
      timeout: { totalMs: 120_000 },
      messages: [{ role: "user", content: "Hello" }],
      providerOptions: {
        openrouter: { reasoning: { effort: "high" } },
      },
    });
    expect(options).not.toHaveProperty("tools");
  });

  it("calls Qwen3.7 Max through its exact OpenRouter id and effort options", async () => {
    mockedGenerateText.mockResolvedValue({
      text: " Qwen response ",
    } as Awaited<ReturnType<typeof generateText>>);
    const service = createService({ openRouter: "router-key" });

    await expect(
      service.generate({
        model: "qwen/qwen3.7-max",
        effort: "medium",
        messages: [{ role: "user", content: "Hello" }],
      }),
    ).resolves.toBe("Qwen response");

    expect(mockedGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({
        providerOptions: {
          openrouter: { reasoning: { effort: "medium" } },
        },
      }),
    );
  });

  it("classifies a permanent provider rejection without leaking its body", async () => {
    mockedGenerateText.mockRejectedValue(
      new APICallError({
        message: "raw provider secret response",
        url: "https://provider.example/v1",
        requestBodyValues: { secret: "do-not-log" },
        responseBody: "credential detail",
        statusCode: 400,
      }),
    );
    const service = createService({ openAi: "openai-key" });

    const error = await service
      .generate({
        model: "openai/gpt-5.6-terra",
        effort: "medium",
        messages: [{ role: "user", content: "Hello" }],
      })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(AssistantGenerationError);
    expect(error).toMatchObject({
      code: "provider_rejected",
      retryable: false,
      message: "Assistant generation failed",
    });
    expect(String(error)).not.toContain("credential detail");
    expect(mockedGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({
        providerOptions: { openai: { reasoningEffort: "medium" } },
      }),
    );
  });

  it("rejects oversized provider output as a permanent persistence failure", async () => {
    mockedGenerateText.mockResolvedValue({
      text: "x".repeat(20_001),
    } as Awaited<ReturnType<typeof generateText>>);
    const service = createService({ openRouter: "router-key" });

    await expect(
      service.generate({
        model: "google/gemini-3.6-flash",
        effort: "low",
        messages: [{ role: "user", content: "Hello" }],
      }),
    ).rejects.toMatchObject({
      code: "generation_failed",
      retryable: false,
    });
  });

  it("fails permanently before any provider call when the key is absent", async () => {
    const service = createService({});

    await expect(
      service.generate({
        model: "google/gemini-3.6-flash",
        effort: "low",
        messages: [{ role: "user", content: "Hello" }],
      }),
    ).rejects.toMatchObject({
      code: "provider_unavailable",
      retryable: false,
    });
    expect(mockedGenerateText).not.toHaveBeenCalled();
  });
});
