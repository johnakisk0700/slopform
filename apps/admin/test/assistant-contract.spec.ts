import { describe, expect, it } from "vitest";

import type { AssistantThread } from "../src/features/assistant/schema";
import {
  ASSISTANT_TURN_STATUSES,
  assistantModelSupportsServiceTier,
  messagesFromThread,
} from "../src/features/assistant/schema";

const THREAD_ID = "2d431350-522a-4a4e-b4db-f9a225601424";
const TURN_ID = "3f4a7749-98a0-4fea-9ccb-89451a44e481";
const REQUEST_ID = "7b16acc2-2499-4fe1-8818-8047107c66d3";
const CREATED_AT = "2026-07-23T09:30:00.000Z";

function turn(
  status: (typeof ASSISTANT_TURN_STATUSES)[number],
  partial: string | null = null,
) {
  const terminal = status === "succeeded" || status === "failed";
  return {
    id: TURN_ID,
    requestId: REQUEST_ID,
    sequence: 1,
    status,
    model: "google/gemini-3.6-flash" as const,
    effort: "low" as const,
    serviceTier: "standard" as const,
    user: { role: "user" as const, content: "Review this plan." },
    assistant:
      status === "succeeded"
        ? { role: "assistant" as const, content: "Reviewed response." }
        : null,
    partial: terminal ? null : partial,
    reasoning: terminal ? null : "Thinking",
    toolCalls: [],
    usage: null,
    error:
      status === "failed"
        ? { code: "generation_failed" as const, message: "Provider detail" }
        : null,
    attempt: 1,
    createdAt: CREATED_AT,
    startedAt: status === "queued" ? null : CREATED_AT,
    completedAt: terminal ? "2026-07-23T09:30:04.000Z" : null,
  };
}

function threadView(status: (typeof ASSISTANT_TURN_STATUSES)[number]) {
  return {
    id: THREAD_ID,
    title: "Review this plan",
    createdAt: CREATED_AT,
    updatedAt: "2026-07-23T09:30:04.000Z",
    turns: [turn(status)],
  } satisfies AssistantThread;
}

describe("assistant durable data contract", () => {
  it("only enables the OpenAI fast lane", () => {
    expect(assistantModelSupportsServiceTier("openai/gpt-5.6-luna")).toBe(true);
    expect(assistantModelSupportsServiceTier("google/gemini-3.6-flash")).toBe(
      false,
    );
    expect(assistantModelSupportsServiceTier("qwen/qwen3.7-max")).toBe(false);
  });

  it("flattens each durable turn into user and assistant messages", () => {
    expect(messagesFromThread(threadView("succeeded"))).toEqual([
      expect.objectContaining({ role: "user", content: "Review this plan." }),
      expect.objectContaining({
        role: "assistant",
        content: "Reviewed response.",
        status: "succeeded",
      }),
    ]);
  });
});
