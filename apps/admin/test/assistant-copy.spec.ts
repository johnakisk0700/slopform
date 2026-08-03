import { beforeAll, describe, expect, it } from "vitest";

const answer = {
  id: "turn-assistant",
  turnId: "7c57f3b8-2b13-48f5-8730-18ac71f490cd",
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

let formatAssistantMessageForCopy: (
  message: typeof answer,
  mode: "answer" | "answer-with-activity",
) => string;

beforeAll(async () => {
  const moduleUrl = new URL(
    "../src/features/assistant/copy.ts",
    import.meta.url,
  ).href;
  ({ formatAssistantMessageForCopy } = (await import(moduleUrl)) as {
    formatAssistantMessageForCopy: typeof formatAssistantMessageForCopy;
  });
});

describe("assistant clipboard formatter", () => {
  it("copies only the answer when activity is not requested", () => {
    expect(formatAssistantMessageForCopy(answer, "answer")).toBe(
      "The final answer.",
    );
  });

  it("copies persisted thinking and bounded tool artifacts with the answer", () => {
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
