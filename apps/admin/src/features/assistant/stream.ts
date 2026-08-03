import * as z from "zod";

import type { AssistantThread } from "./schema";

const attemptSchema = z.number().int().positive();
const accumulatedSchema = z.string().max(20_000);

export const assistantStreamFrameSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("snapshot"),
      attempt: attemptSchema,
      status: z.enum(["queued", "running", "succeeded", "failed"]),
      accumulated: accumulatedSchema.nullable(),
      reasoning: accumulatedSchema.nullable(),
    })
    .strict(),
  z.object({ kind: z.literal("reset"), attempt: attemptSchema }).strict(),
  z
    .object({
      kind: z.literal("text"),
      attempt: attemptSchema,
      accumulated: accumulatedSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("reasoning"),
      attempt: attemptSchema,
      accumulated: accumulatedSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("tools"),
      attempt: attemptSchema,
      accumulated: accumulatedSchema,
    })
    .strict(),
  z.object({ kind: z.literal("done"), attempt: attemptSchema }).strict(),
]);

export type AssistantStreamFrame = z.infer<typeof assistantStreamFrameSchema>;

export interface AssistantLiveTurn {
  readonly turnId: string;
  readonly attempt: number;
  readonly partial: string | null;
  readonly reasoning: string | null;
  /** A provider retry explicitly discarded every older persisted prefix. */
  readonly reset: boolean;
}

export function reduceAssistantLiveTurn(
  current: AssistantLiveTurn | null,
  turnId: string,
  frame: AssistantStreamFrame,
): AssistantLiveTurn | null {
  const compatible =
    current?.turnId === turnId && current.attempt === frame.attempt
      ? current
      : null;

  switch (frame.kind) {
    case "snapshot":
      return {
        turnId,
        attempt: frame.attempt,
        partial: frame.accumulated,
        reasoning: frame.reasoning,
        reset: false,
      };
    case "reset":
      return {
        turnId,
        attempt: frame.attempt,
        partial: null,
        reasoning: null,
        reset: true,
      };
    case "text":
      return {
        ...(compatible ?? emptyLiveTurn(turnId, frame.attempt)),
        partial: frame.accumulated,
      };
    case "reasoning":
      return {
        ...(compatible ?? emptyLiveTurn(turnId, frame.attempt)),
        reasoning: frame.accumulated,
      };
    case "tools":
    case "done":
      return compatible;
  }
}

/** Applies the live accelerator without letting a stale poll shorten a prefix. */
export function overlayAssistantLiveTurn(
  thread: AssistantThread | null,
  live: AssistantLiveTurn | null,
): AssistantThread | null {
  if (!thread || !live) return thread;

  const index = thread.turns.findIndex((turn) => turn.id === live.turnId);
  const turn = thread.turns[index];
  if (
    !turn ||
    turn.attempt !== live.attempt ||
    (turn.status !== "queued" && turn.status !== "running")
  ) {
    return thread;
  }

  const turns = [...thread.turns];
  turns[index] = {
    ...turn,
    partial: live.reset
      ? live.partial
      : newestAccumulated(turn.partial, live.partial),
    reasoning: live.reset
      ? live.reasoning
      : newestAccumulated(turn.reasoning, live.reasoning),
  };
  return { ...thread, turns };
}

/**
 * Reads the deliberately tiny SSE dialect emitted by the assistant endpoint.
 * Malformed/unknown frames are ignored because this channel is only an
 * accelerator; durable polling remains the recovery and authority path.
 */
export async function consumeAssistantEventStream(
  stream: ReadableStream<Uint8Array>,
  onFrame: (frame: AssistantStreamFrame) => void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });
      buffer = consumeBlocks(buffer, onFrame);
    }
    buffer += decoder.decode();
    consumeBlocks(`${buffer}\n\n`, onFrame);
  } finally {
    reader.releaseLock();
  }
}

function consumeBlocks(
  input: string,
  onFrame: (frame: AssistantStreamFrame) => void,
): string {
  let buffer = input;
  while (true) {
    const separator = /\r?\n\r?\n/u.exec(buffer);
    if (!separator || separator.index === undefined) return buffer;

    const block = buffer.slice(0, separator.index);
    buffer = buffer.slice(separator.index + separator[0].length);
    const payload = block
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /u, ""))
      .join("\n");
    if (!payload) continue;

    try {
      const parsed = assistantStreamFrameSchema.safeParse(JSON.parse(payload));
      if (parsed.success) onFrame(parsed.data);
    } catch {
      // Invalid JSON is an accelerator frame we can safely drop.
    }
  }
}

function emptyLiveTurn(turnId: string, attempt: number): AssistantLiveTurn {
  return { turnId, attempt, partial: null, reasoning: null, reset: false };
}

function newestAccumulated(
  persisted: string | null,
  live: string | null,
): string | null {
  if (live === null) return persisted;
  if (persisted === null || live.startsWith(persisted)) return live;
  if (persisted.startsWith(live)) return persisted;
  return live;
}
