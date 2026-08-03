import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";

interface ArtifactSchemaModule {
  assistantThreadSchema: { parse: (input: unknown) => unknown };
  messagesFromThread: (thread: unknown) => Array<Record<string, unknown>>;
}

interface ToolCallCardProps {
  call: {
    toolCallId: string;
    tool: string;
    label: string;
    state: "done";
    input: Record<string, unknown>;
    output: Record<string, unknown>;
    inputTruncated: boolean;
    outputTruncated: boolean;
  };
}

let artifacts: ArtifactSchemaModule;
let ToolCallCard: ComponentType<ToolCallCardProps>;
let ReasoningCard: ComponentType<{ reasoning: string; streaming: boolean }>;
let formatCost: (euroMicros: number) => string;
let calculateReplyMinHeight: (
  viewportHeight: number,
  userMessageHeight: number,
) => number;
let calculateQuestionScrollTop: (
  currentScrollTop: number,
  questionTop: number,
  viewportTop: number,
) => number;

beforeAll(async () => {
  const [schemaModule, cardModule, reasoningModule, costModule, layoutModule] =
    await Promise.all([
      import(
        new URL("../src/features/assistant/schema.ts", import.meta.url).href
      ),
      import(
        new URL(
          "../src/components/admin/assistant/AssistantToolCallCard.tsx",
          import.meta.url,
        ).href
      ),
      import(
        new URL(
          "../src/components/admin/assistant/AssistantReasoningCard.tsx",
          import.meta.url,
        ).href
      ),
      import(
        new URL("../src/features/assistant/cost.ts", import.meta.url).href
      ),
      import(
        new URL("../src/features/assistant/layout.ts", import.meta.url).href
      ),
    ]);
  artifacts = schemaModule as ArtifactSchemaModule;
  ToolCallCard =
    cardModule.AssistantToolCallCard as ComponentType<ToolCallCardProps>;
  ReasoningCard = reasoningModule.AssistantReasoningCard as ComponentType<{
    reasoning: string;
    streaming: boolean;
  }>;
  formatCost = costModule.formatEstimatedAssistantCost as (
    euroMicros: number,
  ) => string;
  calculateReplyMinHeight = layoutModule.calculateAssistantReplyMinHeight as (
    viewportHeight: number,
    userMessageHeight: number,
  ) => number;
  calculateQuestionScrollTop =
    layoutModule.calculateAssistantQuestionScrollTop as (
      currentScrollTop: number,
      questionTop: number,
      viewportTop: number,
    ) => number;
});
describe("assistant turn artifacts", () => {
  it("keeps tool calls, reasoning and priced usage on a settled message", () => {
    const thread = artifacts.assistantThreadSchema.parse({
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
    });

    expect(artifacts.messagesFromThread(thread)[1]).toMatchObject({
      role: "assistant",
      reasoning: "I checked the scheduled events.",
      toolCalls: [expect.objectContaining({ toolCallId: "call-1" })],
      usage: { estimatedCostEurMicros: 42 },
    });
  });

  it("renders tool and reasoning cards on the same copied disclosure row", () => {
    const html = renderToStaticMarkup(
      createElement(ToolCallCard, {
        call: {
          toolCallId: "call-1",
          tool: "list_events",
          label: "Searching events",
          state: "done",
          input: { status: "scheduled" },
          output: { items: [] },
          inputTruncated: false,
          outputTruncated: false,
        },
      }),
    );

    expect(html).toContain("<details");
    expect(html).toContain("Searching events");
    expect(html).toContain("scheduled");
    expect(html).toContain("Result");

    const reasoningHtml = renderToStaticMarkup(
      createElement(ReasoningCard, {
        reasoning: "I checked the live schedule.",
        streaming: false,
      }),
    );
    const summaryClass = (markup: string) =>
      markup.match(/<summary class="([^"]+)"/u)?.[1];
    expect(summaryClass(html)).toBeTruthy();
    expect(summaryClass(reasoningHtml)).toBe(summaryClass(html));
    expect(summaryClass(html)).toContain("min-h-8");
  });

  it("keeps the latest reply tall enough to anchor its question at the top", () => {
    expect(calculateReplyMinHeight(700, 40)).toBe(636);
    expect(calculateReplyMinHeight(260, 40)).toBe(300);
    expect(calculateQuestionScrollTop(24, 129, 73)).toBe(68);
  });

  it("formats tiny per-turn costs honestly as estimates", () => {
    expect(formatCost(42)).toBe("<€0.001");
    expect(formatCost(12_340)).toContain("€0.0123");
  });
});
