import type { ConfigService } from "@nestjs/config";
import { APICallError, generateText, streamText } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Environment } from "../../infrastructure/config/environment.js";
import {
  AssistantGenerationError,
  AssistantGenerationService,
} from "./assistant-generation.service.js";
import { AssistantToolsService } from "./tools/assistant-tools.service.js";

vi.mock("ai", async (importOriginal) => {
  const original = await importOriginal<typeof import("ai")>();
  return { ...original, generateText: vi.fn(), streamText: vi.fn() };
});

const mockedGenerateText = vi.mocked(generateText);
const mockedStreamText = vi.mocked(streamText);

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
  // The real registry, with domain doubles behind it: what these tests assert
  // is that the same tool set reaches every provider, so a stub tool set here
  // would only prove the stub.
  const tools = new AssistantToolsService(
    { list: vi.fn(), get: vi.fn() } as never,
    { list: vi.fn(), get: vi.fn(), listEvents: vi.fn() } as never,
    { list: vi.fn(), get: vi.fn() } as never,
    { listForCampaign: vi.fn(), get: vi.fn() } as never,
    { get: vi.fn() } as never,
  );
  return new AssistantGenerationService(config, tools);
}

const EXPECTED_TOOL_NAMES = [
  "current_datetime",
  "list_events",
  "get_event",
  "search_participants",
  "get_participant",
  "list_feedback_campaigns",
  "get_campaign_summary",
  "list_feedback_conversations",
  "get_feedback_conversation",
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AssistantGenerationService", () => {
  it("pins OpenRouter routing to tool-capable providers and skips hidden SDK retries", async () => {
    mockedGenerateText.mockResolvedValue({
      text: "  Hello from Gemini  ",
    } as Awaited<ReturnType<typeof generateText>>);
    const service = createService({ openRouter: "router-key" });

    await expect(
      service.generate({
        model: "google/gemini-3.6-flash",
        effort: "high",
        serviceTier: "standard",
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
        openrouter: {
          reasoning: { effort: "high" },
          provider: { require_parameters: true },
        },
      },
    });
    expect(Object.keys(options?.tools ?? {})).toEqual(EXPECTED_TOOL_NAMES);
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
        serviceTier: "standard",
        messages: [{ role: "user", content: "Hello" }],
      }),
    ).resolves.toBe("Qwen response");

    expect(mockedGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({
        providerOptions: {
          openrouter: {
            reasoning: { effort: "medium" },
            provider: { require_parameters: true },
          },
        },
      }),
    );
  });

  it("streams Luna through OpenAI direct with the selected effort", async () => {
    mockedStreamText.mockReturnValue({
      // The service reads `fullStream`, so reasoning parts reach it alongside
      // text instead of being dropped by `textStream`.
      fullStream: (async function* () {
        yield { type: "reasoning-delta", text: "Weighing " };
        yield { type: "text-delta", text: "Luna" };
        yield { type: "reasoning-delta", text: "the answer" };
        yield { type: "text-delta", text: " response" };
      })(),
      usage: Promise.resolve({
        inputTokens: 11,
        outputTokens: 7,
        totalTokens: 18,
        outputTokenDetails: { reasoningTokens: 4 },
        inputTokenDetails: { cacheReadTokens: 3 },
      }),
    } as unknown as ReturnType<typeof streamText>);
    const service = createService({ openAi: "openai-key" });
    const deltas: string[] = [];
    const reasoningDeltas: string[] = [];

    await expect(
      service.generateStreaming({
        model: "openai/gpt-5.6-luna",
        effort: "high",
        serviceTier: "standard",
        messages: [{ role: "user", content: "Hello" }],
        onDelta: (accumulated) => deltas.push(accumulated),
        onReasoningDelta: (accumulated) => reasoningDeltas.push(accumulated),
      }),
    ).resolves.toEqual({
      content: "Luna response",
      reasoning: "Weighing the answer",
      usage: {
        inputTokens: 11,
        outputTokens: 7,
        reasoningTokens: 4,
        cachedInputTokens: 3,
        totalTokens: 18,
      },
    });

    expect(deltas).toEqual(["Luna", "Luna response"]);
    expect(reasoningDeltas).toEqual(["Weighing ", "Weighing the answer"]);
    expect(mockedStreamText).toHaveBeenCalledWith(
      expect.objectContaining({
        providerOptions: {
          openai: { reasoningEffort: "high" },
        },
      }),
    );
    // The streaming path offers the same tools as the buffered one; the fast
    // lane is an OpenAI request parameter, so no OpenRouter routing pin here.
    const streamed = mockedStreamText.mock.calls[0]?.[0];
    expect(Object.keys(streamed?.tools ?? {})).toEqual(EXPECTED_TOOL_NAMES);
    expect(streamed?.providerOptions).not.toHaveProperty("openrouter");
    expect(mockedGenerateText).not.toHaveBeenCalled();
  });

  /**
   * Tool activity is published as the whole accumulated list on every change,
   * the same rule text and reasoning follow, so a reader that drops frames is
   * still correct on the next one. It carries operator wording rather than the
   * function name, because this is what an operator reads while they wait.
   */
  it("reports each tool call as it starts and as it settles", async () => {
    mockedStreamText.mockReturnValue({
      fullStream: (async function* () {
        yield {
          type: "tool-call",
          toolCallId: "call-1",
          toolName: "list_events",
        };
        yield {
          type: "tool-result",
          toolCallId: "call-1",
          toolName: "list_events",
        };
        yield {
          type: "tool-call",
          toolCallId: "call-2",
          toolName: "get_event",
        };
        yield {
          type: "tool-error",
          toolCallId: "call-2",
          toolName: "get_event",
        };
        yield { type: "text-delta", text: "Done" };
      })(),
      usage: Promise.resolve({
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
      }),
    } as unknown as ReturnType<typeof streamText>);
    const service = createService({ openAi: "openai-key" });
    const frames: { label: string; state: string }[][] = [];

    await service.generateStreaming({
      model: "openai/gpt-5.6-luna",
      effort: "low",
      serviceTier: "standard",
      messages: [{ role: "user", content: "Hello" }],
      onDelta: () => {},
      onToolActivity: (activity) =>
        frames.push(
          activity.map((entry) => ({
            label: entry.label,
            state: entry.state,
          })),
        ),
    });

    expect(frames).toEqual([
      [{ label: "Searching events", state: "running" }],
      [{ label: "Searching events", state: "done" }],
      [
        { label: "Searching events", state: "done" },
        { label: "Reading an event", state: "running" },
      ],
      [
        { label: "Searching events", state: "done" },
        { label: "Reading an event", state: "failed" },
      ],
    ]);
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
        serviceTier: "standard",
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
    // Luna and Terra both ride OpenAI direct so reasoning effort is an explicit
    // OpenAI request parameter.
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
        serviceTier: "standard",
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
        serviceTier: "standard",
        messages: [{ role: "user", content: "Hello" }],
      }),
    ).rejects.toMatchObject({
      code: "provider_unavailable",
      retryable: false,
    });
    expect(mockedGenerateText).not.toHaveBeenCalled();
  });
});
