import { describe, expect, it } from "vitest";

import {
  consumeAssistantEventStream,
  overlayAssistantLiveTurn,
  reduceAssistantLiveTurn,
} from "../src/features/assistant/stream";
import type { AssistantThread } from "../src/features/assistant/schema";

const thread = {
  id: "66de52a8-1a26-4cbb-b8d1-fcf8bdc2dd51",
  title: "Hello",
  createdAt: "2026-08-03T00:00:00.000Z",
  updatedAt: "2026-08-03T00:00:00.000Z",
  turns: [
    {
      id: "7c57f3b8-2b13-48f5-8730-18ac71f490cd",
      requestId: "a8e94f93-9909-4cf2-b580-3b55c287a452",
      sequence: 1,
      status: "running" as const,
      model: "google/gemini-3.6-flash" as const,
      effort: "low" as const,
      serviceTier: "standard" as const,
      user: { role: "user" as const, content: "Hello" },
      assistant: null,
      partial: "Persisted",
      reasoning: null,
      toolCalls: [],
      usage: null,
      error: null,
      attempt: 1,
      createdAt: "2026-08-03T00:00:00.000Z",
      startedAt: "2026-08-03T00:00:01.000Z",
      completedAt: null,
    },
  ],
} satisfies AssistantThread;

function firstTurnId(): string {
  const turn = thread.turns[0];
  if (!turn) {
    throw new Error("test thread has no turns");
  }
  return turn.id;
}

describe("assistant event stream", () => {
  it("parses split frames and ignores malformed accelerator data", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode('data: {"kind":"text","attempt":1,"acc'),
        );
        controller.enqueue(
          encoder.encode(
            'umulated":"Hello"}\n\ndata: not-json\n\ndata: {"kind":"done","attempt":1}\n\n',
          ),
        );
        controller.close();
      },
    });
    const frames: unknown[] = [];

    await consumeAssistantEventStream(stream, (frame) => frames.push(frame));

    expect(frames).toEqual([
      { kind: "text", attempt: 1, accumulated: "Hello" },
      { kind: "done", attempt: 1 },
    ]);
  });

  it("keeps live text and tool activity ahead of a stale durable poll", () => {
    const live = reduceAssistantLiveTurn(null, firstTurnId(), {
      kind: "text",
      attempt: 1,
      accumulated: "Persisted and live",
    });

    expect(overlayAssistantLiveTurn(thread, live)?.turns[0]?.partial).toBe(
      "Persisted and live",
    );

    const tools = reduceAssistantLiveTurn(live, firstTurnId(), {
      kind: "tools",
      attempt: 1,
      accumulated: JSON.stringify([
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
      ]),
    });

    expect(
      overlayAssistantLiveTurn(thread, tools)?.turns[0]?.toolCalls,
    ).toEqual([
      expect.objectContaining({ toolCallId: "call-1", state: "done" }),
    ]);
  });

  it("lets a provider reset discard older prefixes", () => {
    const live = reduceAssistantLiveTurn(null, firstTurnId(), {
      kind: "reset",
      attempt: 1,
    });

    expect(overlayAssistantLiveTurn(thread, live)?.turns[0]).toEqual(
      expect.objectContaining({
        partial: null,
        reasoning: null,
        toolCalls: [],
      }),
    );
  });
});
