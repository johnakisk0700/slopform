import { beforeAll, describe, expect, it } from "vitest";

interface StreamModule {
  consumeAssistantEventStream: (
    stream: ReadableStream<Uint8Array>,
    onFrame: (frame: Record<string, unknown>) => void,
  ) => Promise<void>;
  overlayAssistantLiveTurn: (
    thread: unknown,
    live: unknown,
  ) => {
    turns: Array<{
      partial: string | null;
      toolCalls: Array<Record<string, unknown>>;
    }>;
  } | null;
  reduceAssistantLiveTurn: (
    current: unknown,
    turnId: string,
    frame: Record<string, unknown>,
  ) => unknown;
}

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
      status: "running",
      model: "google/gemini-3.6-flash",
      effort: "low",
      serviceTier: "standard",
      user: { role: "user", content: "Hello" },
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
};

let streamContract: StreamModule;

beforeAll(async () => {
  const moduleUrl = new URL(
    "../src/features/assistant/stream.ts",
    import.meta.url,
  ).href;
  streamContract = (await import(moduleUrl)) as StreamModule;
});

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
    const frames: Array<Record<string, unknown>> = [];

    await streamContract.consumeAssistantEventStream(stream, (frame) =>
      frames.push(frame),
    );

    expect(frames).toEqual([
      { kind: "text", attempt: 1, accumulated: "Hello" },
      { kind: "done", attempt: 1 },
    ]);
  });

  it("keeps a live prefix ahead of a stale durable poll", () => {
    const live = streamContract.reduceAssistantLiveTurn(
      null,
      thread.turns[0]!.id,
      {
        kind: "text",
        attempt: 1,
        accumulated: "Persisted and live",
      },
    );

    expect(
      streamContract.overlayAssistantLiveTurn(thread, live)?.turns[0]?.partial,
    ).toBe("Persisted and live");
  });

  it("lets an explicit provider retry discard older artifacts", () => {
    const live = streamContract.reduceAssistantLiveTurn(
      null,
      thread.turns[0]!.id,
      {
        kind: "reset",
        attempt: 1,
      },
    );
    const overlaid = streamContract.overlayAssistantLiveTurn(thread, live)
      ?.turns[0];

    expect(overlaid?.partial).toBeNull();
    expect(overlaid?.toolCalls).toEqual([]);
  });

  it("applies accumulated tool activity over a stale poll", () => {
    const live = streamContract.reduceAssistantLiveTurn(
      null,
      thread.turns[0]!.id,
      {
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
      },
    );

    expect(
      streamContract.overlayAssistantLiveTurn(thread, live)?.turns[0]
        ?.toolCalls,
    ).toEqual([
      expect.objectContaining({ toolCallId: "call-1", state: "done" }),
    ]);
  });
});
