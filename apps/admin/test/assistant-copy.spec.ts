import { describe, expect, it } from "vitest";

import { formatAssistantMessageForCopy } from "../src/features/assistant/copy";
import type { AssistantDisplayMessage } from "../src/features/assistant/schema";

const answer: AssistantDisplayMessage = {
  id: "turn-assistant",
  turnId: "turn-1",
  role: "assistant",
  content: "The final answer.",
  model: "google/gemini-3.6-flash",
  effort: "low",
  serviceTier: "standard",
  reasoning: "I compared the two event plans.",
  toolCalls: [
    {
      toolCallId: "tool-1",
      tool: "list_events",
      label: "Searching events",
      state: "done",
      input: { limit: 2 },
      output: { rows: [{ title: "Dinner" }] },
      inputTruncated: false,
      outputTruncated: true,
    },
  ],
  usage: null,
  status: "succeeded",
};

describe("assistant clipboard formatter", () => {
  it("copies only the answer when activity is not requested", () => {
    expect(formatAssistantMessageForCopy(answer, "answer")).toBe(
      "The final answer.",
    );
  });

  it("includes durable thinking and bounded tool artifacts on request", () => {
    const copied = formatAssistantMessageForCopy(
      answer,
      "answer-with-activity",
    );

    expect(copied).toContain("Thinking\n\nI compared the two event plans.");
    expect(copied).toContain(
      "Tools\n\n- Searching events (list_events) — done",
    );
    expect(copied).toContain('    "limit": 2');
    expect(copied).toContain("Result (truncated):");
    expect(copied).toContain("Answer\n\nThe final answer.");
  });
});
