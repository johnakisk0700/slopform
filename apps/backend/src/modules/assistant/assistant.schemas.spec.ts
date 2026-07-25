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
