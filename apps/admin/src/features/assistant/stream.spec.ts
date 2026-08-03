import { describe, expect, it } from "vitest";

import type { AssistantThread } from "./schema";
import {
  consumeAssistantEventStream,
  overlayAssistantLiveTurn,
  reduceAssistantLiveTurn,
  type AssistantStreamFrame,
} from "./stream";

const thread: AssistantThread = {
  id: "66de52a8-1a26-4cbb-b8d1-fcf8bdc2dd51",
  title: "Hello",
  createdAt: "2026-08-03T00:00:00.000Z",
  updatedAt: "2026-08-03T00:00:00.000Z",
  turns: [
    {
      id: "7c57f3b8-2b13-48f5-8730-18ac71f490cd",
      requestId: "a8e94f93-9909-4cf2-b580-3b55c287a452",
      sequence: 1,
      status: "running",
      model: "google/gemini-3.6-flash",
      effort: "low",
      serviceTier: "standard",
      user: { role: "user", content: "Hello" },
      assistant: null,
      partial: "Persisted",
      reasoning: null,
      error: null,
      attempt: 1,
      createdAt: "2026-08-03T00:00:00.000Z",
      startedAt: "2026-08-03T00:00:01.000Z",
      completedAt: null,
    },
  ],
};

describe("assistant event stream", () => {
  it("parses frames split across chunks and ignores malformed accelerator data", async () => {
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
    const frames: AssistantStreamFrame[] = [];

    await consumeAssistantEventStream(stream, (frame) => frames.push(frame));

    expect(frames).toEqual([
      { kind: "text", attempt: 1, accumulated: "Hello" },
      { kind: "done", attempt: 1 },
    ]);
  });

  it("keeps a live prefix ahead of a stale durable poll", () => {
    const live = reduceAssistantLiveTurn(null, thread.turns[0]!.id, {
      kind: "text",
      attempt: 1,
      accumulated: "Persisted and live",
    });

    expect(overlayAssistantLiveTurn(thread, live)?.turns[0]?.partial).toBe(
      "Persisted and live",
    );
  });

  it("lets an explicit provider retry reset discard an older prefix", () => {
    const live = reduceAssistantLiveTurn(null, thread.turns[0]!.id, {
      kind: "reset",
      attempt: 1,
    });

    expect(
      overlayAssistantLiveTurn(thread, live)?.turns[0]?.partial,
    ).toBeNull();
  });
});
