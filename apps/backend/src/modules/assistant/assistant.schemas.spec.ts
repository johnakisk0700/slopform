import { describe, expect, it } from "vitest";

import { ASSISTANT_MODEL_ADAPTERS } from "./assistant-models.js";
import {
  ASSISTANT_JOB_NAMES,
  assistantJobDataSchema,
  assistantTurnSchema,
  createAssistantTurnJobId,
  createAssistantTurnSchema,
  parseAssistantTurnJobAttempt,
} from "./assistant.schemas.js";

const turnId = "7c57f3b8-2b13-48f5-8730-18ac71f490cd";
const requestId = "a8e94f93-9909-4cf2-b580-3b55c287a452";

describe("assistant schemas", () => {
  it("accepts one bounded, idempotent user turn and trims content", () => {
    expect(
      createAssistantTurnSchema.parse({
        requestId,
        model: "google/gemini-3.6-flash",
        content: " hello ",
      }),
    ).toEqual({
      requestId,
      model: "google/gemini-3.6-flash",
      effort: "low",
      content: "hello",
    });
    expect(() =>
      createAssistantTurnSchema.parse({ requestId, content: " " }),
    ).toThrow();
  });

  it("maps every public model id to the exact provider model id", () => {
    expect(ASSISTANT_MODEL_ADAPTERS).toEqual({
      "openai/gpt-5.6-luna": {
        provider: "openai",
        providerModelId: "gpt-5.6-luna",
      },
      "openai/gpt-5.6-terra": {
        provider: "openai",
        providerModelId: "gpt-5.6-terra",
      },
      "google/gemini-3.6-flash": {
        provider: "openrouter",
        providerModelId: "google/gemini-3.6-flash",
      },
      "qwen/qwen3.7-max": {
        provider: "openrouter",
        providerModelId: "qwen/qwen3.7-max",
      },
    });
  });

  // The failure this guards against is silent: an entry naming a provider this
  // deployment holds no credit with still typechecks, still reads like a
  // deliberate route, and only shows up as `provider_error` on every call.
  //
  // Two providers are funded as of 2026-07-31, so this can no longer assert a
  // single route. What it can still assert is the half that was silently wrong
  // for free: the id shape has to match the provider that receives it, and the
  // two vocabularies are incompatible. OpenRouter addresses models as
  // `vendor/model` and resolves a bare name to nothing; OpenAI wants the bare
  // name and rejects the prefixed one. Either mistake is a 404 on every call.
  it("routes every model through a funded provider, addressed the way that provider expects", () => {
    const funded = new Set(["openrouter", "openai"]);
    for (const [model, adapter] of Object.entries(ASSISTANT_MODEL_ADAPTERS)) {
      expect(funded.has(adapter.provider), model).toBe(true);
      expect(adapter.providerModelId.includes("/"), model).toBe(
        adapter.provider === "openrouter",
      );
    }
  });

  it("keeps the v2 job envelope strict and identifier-only", () => {
    const data = {
      schemaVersion: 2,
      turnId,
      correlationId: "request-1",
    } as const;
    expect(assistantJobDataSchema.parse(data)).toEqual(data);
    expect(() =>
      assistantJobDataSchema.parse({
        ...data,
        content: "must stay in postgres",
      }),
    ).toThrow();
    expect(ASSISTANT_JOB_NAMES.generateTurnV2).toBe(
      "assistant.generate-turn.v2",
    );
    expect(createAssistantTurnJobId(turnId, 3)).toBe(
      `assistant-generate-v2-${turnId}-3`,
    );
    expect(
      parseAssistantTurnJobAttempt(`assistant-generate-v2-${turnId}-3`, turnId),
    ).toBe(3);
    expect(parseAssistantTurnJobAttempt("wrong", turnId)).toBeUndefined();
  });

  it("rejects incoherent terminal turn states", () => {
    expect(() =>
      assistantTurnSchema.parse({
        id: turnId,
        requestId,
        sequence: 1,
        status: "succeeded",
        model: "google/gemini-3.6-flash",
        effort: "low",
        user: { role: "user", content: "Hello" },
        assistant: null,
        error: null,
        attempt: 1,
        createdAt: "2026-07-23T10:00:00.000Z",
        startedAt: "2026-07-23T10:00:01.000Z",
        completedAt: "2026-07-23T10:00:02.000Z",
      }),
    ).toThrow(/succeeded turn requires/);
  });
});
