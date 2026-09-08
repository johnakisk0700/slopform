import { describe, expect, it } from "vitest";

import { formatEstimatedAssistantCost } from "../src/features/assistant/cost";
import {
  calculateAssistantQuestionScrollTop,
  calculateAssistantReplyMinHeight,
} from "../src/features/assistant/layout";
import { messagesFromThread } from "../src/features/assistant/schema";
import type { AssistantThread } from "../src/features/assistant/schema";

describe("assistant turn artifacts", () => {
  it("keeps reasoning, tool calls and usage on a settled message", () => {
    const thread = {
      id: "66de52a8-1a26-4cbb-b8d1-fcf8bdc2dd51",
      title: "Events",
      createdAt: "2026-08-03T00:00:00.000Z",
      updatedAt: "2026-08-03T00:00:02.000Z",
      turns: [
        {
          id: "7c57f3b8-2b13-48f5-8730-18ac71f490cd",
          requestId: "a8e94f93-9909-4cf2-b580-3b55c287a452",
          sequence: 1,
          status: "succeeded",
          model: "openai/gpt-5.6-luna",
          effort: "low",
          serviceTier: "standard",
          user: { role: "user", content: "List events" },
          assistant: { role: "assistant", content: "No events." },
          partial: null,
          reasoning: "I checked the scheduled events.",
          toolCalls: [
            {
              toolCallId: "call-1",
              tool: "list_events",
              label: "Searching events",
              state: "done",
              input: { status: "scheduled" },
              output: { items: [] },
              inputTruncated: false,
              outputTruncated: false,
            },
          ],
          usage: {
            inputTokens: 100,
            outputTokens: 20,
            reasoningTokens: 5,
            cachedInputTokens: 10,
            totalTokens: 120,
            estimatedCostEurMicros: 42,
            pricingVersion: "2026-08-03",
          },
          error: null,
          attempt: 1,
          createdAt: "2026-08-03T00:00:00.000Z",
          startedAt: "2026-08-03T00:00:01.000Z",
          completedAt: "2026-08-03T00:00:02.000Z",
        },
      ],
    } satisfies AssistantThread;

    expect(messagesFromThread(thread)[1]).toMatchObject({
      role: "assistant",
      reasoning: "I checked the scheduled events.",
      toolCalls: [expect.objectContaining({ toolCallId: "call-1" })],
      usage: { estimatedCostEurMicros: 42 },
    });
  });

  it("reserves room for the newest reply and computes one scroll target", () => {
    expect(calculateAssistantReplyMinHeight(700, 40)).toBe(636);
    expect(calculateAssistantReplyMinHeight(260, 40)).toBe(300);
    expect(calculateAssistantQuestionScrollTop(24, 129, 73)).toBe(68);
  });

  it("formats small costs without claiming false precision", () => {
    expect(formatEstimatedAssistantCost(42)).toBe("<€0.001");
    expect(formatEstimatedAssistantCost(12_340)).toContain("€0.0123");
  });
});
