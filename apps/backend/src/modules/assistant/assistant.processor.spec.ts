import type { AssistantTurnRow } from "@join-the-six/database";
import { UnrecoverableError, type Job } from "bullmq";
import { describe, expect, it, vi } from "vitest";

import {
  AssistantGenerationError,
  type AssistantGenerationService,
} from "./assistant-generation.service.js";
import {
  ASSISTANT_JOB_NAMES,
  type AssistantJobData,
  type AssistantJobName,
} from "./assistant.schemas.js";
import type { AssistantService } from "./assistant.service.js";
import { AssistantProcessor } from "./assistant.processor.js";

const threadId = "66de52a8-1a26-4cbb-b8d1-fcf8bdc2dd51";
const turnId = "7c57f3b8-2b13-48f5-8730-18ac71f490cd";
const runningTurn: AssistantTurnRow = {
  id: turnId,
  threadId,
  createdBy: "user_owner",
  requestId: "a8e94f93-9909-4cf2-b580-3b55c287a452",
  sequence: 1,
  status: "running",
  model: "google/gemini-3.6-flash",
  effort: "low",
  attempt: 1,
  userContent: "Hello",
  assistantContent: null,
  errorCode: null,
  errorMessage: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  startedAt: new Date(),
  completedAt: null,
};
const messages = [{ role: "user" as const, content: "Hello" }];

function createJob(options?: {
  readonly attempts?: number;
  readonly attemptsMade?: number;
  readonly data?: unknown;
  readonly id?: string;
  readonly name?: string;
}): Job<AssistantJobData, void, AssistantJobName> {
  return {
    id: options?.id ?? `assistant-generate-v2-${turnId}-1`,
    name: options?.name ?? ASSISTANT_JOB_NAMES.generateTurnV2,
    data:
      options?.data ??
      ({ schemaVersion: 2, turnId, correlationId: "request-1" } as const),
    attemptsMade: options?.attemptsMade ?? 0,
    opts: { attempts: options?.attempts ?? 5 },
  } as unknown as Job<AssistantJobData, void, AssistantJobName>;
}

function createProcessor(options?: {
  readonly generationError?: Error;
  readonly turn?: AssistantTurnRow;
  readonly messages?: typeof messages | [];
}): {
  readonly assistant: {
    markFailed: ReturnType<typeof vi.fn>;
    markQueued: ReturnType<typeof vi.fn>;
    markSucceeded: ReturnType<typeof vi.fn>;
    start: ReturnType<typeof vi.fn>;
  };
  readonly generate: ReturnType<typeof vi.fn>;
  readonly processor: AssistantProcessor;
} {
  const assistant = {
    start: vi.fn().mockResolvedValue({
      turn: options?.turn ?? runningTurn,
      messages: options?.messages ?? messages,
    }),
    markSucceeded: vi.fn().mockResolvedValue(undefined),
    markFailed: vi.fn().mockResolvedValue(undefined),
    markQueued: vi.fn().mockResolvedValue(undefined),
  };
  const generate = options?.generationError
    ? vi.fn().mockRejectedValue(options.generationError)
    : vi.fn().mockResolvedValue("Generated response");
  const processor = new AssistantProcessor(
    assistant as unknown as AssistantService,
    { generate } as unknown as AssistantGenerationService,
  );
  return { assistant, generate, processor };
}

describe("AssistantProcessor", () => {
  it("rejects unsupported names, malformed envelopes and unfenced job ids", async () => {
    const { assistant, processor } = createProcessor();
    await expect(
      processor.process(createJob({ name: "assistant.unknown" })),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    await expect(
      processor.process(createJob({ data: { turnId } })),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    await expect(
      processor.process(createJob({ id: "wrong" })),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect(assistant.start).not.toHaveBeenCalled();
  });

  it("generates from durable context and persists the exact attempt", async () => {
    const { assistant, generate, processor } = createProcessor();
    await expect(processor.process(createJob())).resolves.toBeUndefined();
    expect(assistant.start).toHaveBeenCalledWith(turnId, 1);
    expect(generate).toHaveBeenCalledWith({
      model: "google/gemini-3.6-flash",
      effort: "low",
      messages,
    });
    expect(assistant.markSucceeded).toHaveBeenCalledWith(
      turnId,
      1,
      "Generated response",
    );
  });

  it("does nothing when a stale delivery has no executable context", async () => {
    const { assistant, generate, processor } = createProcessor({
      messages: [],
    });
    await expect(processor.process(createJob())).resolves.toBeUndefined();
    expect(generate).not.toHaveBeenCalled();
    expect(assistant.markSucceeded).not.toHaveBeenCalled();
  });

  it("persists permanent provider failures and stops retries", async () => {
    const { assistant, processor } = createProcessor({
      generationError: new AssistantGenerationError("provider_rejected", false),
    });
    await expect(processor.process(createJob())).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    expect(assistant.markFailed).toHaveBeenCalledWith(
      turnId,
      1,
      "provider_rejected",
      "The assistant provider rejected the request.",
    );
  });

  it("returns transient failures to queued state before BullMQ retries", async () => {
    const { assistant, processor } = createProcessor({
      generationError: new AssistantGenerationError("generation_failed", true),
    });
    await expect(processor.process(createJob())).rejects.toBeInstanceOf(
      AssistantGenerationError,
    );
    expect(assistant.markQueued).toHaveBeenCalledWith(turnId, 1);
    expect(assistant.markFailed).not.toHaveBeenCalled();
  });

  it("does not leave the final unexpected failure stuck running", async () => {
    const { assistant, processor } = createProcessor({
      generationError: new Error("unexpected provider shape with secrets"),
    });
    await expect(
      processor.process(createJob({ attempts: 5, attemptsMade: 4 })),
    ).rejects.toBeInstanceOf(AssistantGenerationError);
    expect(assistant.markFailed).toHaveBeenCalledWith(
      turnId,
      1,
      "generation_failed",
      "The assistant could not generate a response.",
    );
  });

  it("reconciles a terminal worker-level failure outside process catch", async () => {
    const { assistant, processor } = createProcessor();

    await processor.onFailed(
      createJob({ attempts: 5, attemptsMade: 5 }),
      new Error("worker-level failure"),
      "active",
    );

    expect(assistant.markFailed).toHaveBeenCalledWith(
      turnId,
      1,
      "generation_failed",
      "The assistant could not generate a response.",
    );
  });

  it("does not reconcile a worker event that BullMQ will retry", async () => {
    const { assistant, processor } = createProcessor();

    await processor.onFailed(
      createJob({ attempts: 5, attemptsMade: 1 }),
      new Error("transient worker-level failure"),
      "active",
    );

    expect(assistant.markFailed).not.toHaveBeenCalled();
  });
});
