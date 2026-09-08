import { describe, expect, it } from "vitest";
import {
  ASSISTANT_JOB_NAMES,
  assistantJobDataSchema,
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
      serviceTier: "standard",
      content: "hello",
    });
    expect(() =>
      createAssistantTurnSchema.parse({ requestId, content: " " }),
    ).toThrow();
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
});
