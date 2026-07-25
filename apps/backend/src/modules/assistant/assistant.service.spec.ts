import type { ConfigService } from "@nestjs/config";
import type {
  AssistantThreadRow,
  AssistantTurnRow,
} from "@join-the-six/database";
import { describe, expect, it, vi } from "vitest";

import type { Environment } from "../../infrastructure/config/environment.js";
import type { AssistantRepository } from "./assistant.repository.js";
import {
  AssistantProviderUnavailableError,
  AssistantService,
  AssistantThreadNotFoundError,
  AssistantTurnConflictError,
} from "./assistant.service.js";

const thread: AssistantThreadRow = {
  id: "66de52a8-1a26-4cbb-b8d1-fcf8bdc2dd51",
  createdBy: "user_owner",
  title: "Hello",
  createdAt: new Date("2026-07-23T10:00:00.000Z"),
  updatedAt: new Date("2026-07-23T10:00:00.000Z"),
};
const turn: AssistantTurnRow = {
  id: "7c57f3b8-2b13-48f5-8730-18ac71f490cd",
  threadId: thread.id,
  createdBy: "user_owner",
  requestId: "a8e94f93-9909-4cf2-b580-3b55c287a452",
  sequence: 1,
  status: "queued",
  model: "google/gemini-3.6-flash",
  effort: "low",
  attempt: 1,
  userContent: "Hello",
  assistantContent: null,
  errorCode: null,
  errorMessage: null,
  createdAt: thread.createdAt,
  updatedAt: thread.updatedAt,
  startedAt: null,
  completedAt: null,
};

function createService(options?: {
  readonly openAi?: boolean;
  readonly openRouter?: boolean;
}): {
  readonly repository: Record<string, ReturnType<typeof vi.fn>>;
  readonly service: AssistantService;
} {
  const values: Partial<Record<keyof Environment, unknown>> = {
    OPENAI_API_KEY: options?.openAi ? "openai-key" : undefined,
    OPENROUTER_API_KEY: options?.openRouter ? "openrouter-key" : undefined,
  };
  const config = {
    get: vi.fn((key: keyof Environment) => values[key]),
  } as unknown as ConfigService<Environment, true>;
  const repository = {
    createThreadWithTurn: vi
      .fn()
      .mockResolvedValue({ created: true, thread, turn }),
    appendTurn: vi.fn().mockResolvedValue({ created: true, thread, turn }),
    findRequestForOwner: vi.fn().mockResolvedValue(undefined),
    findThreadRecordForOwner: vi
      .fn()
      .mockResolvedValue({ thread, turns: [turn] }),
    listThreadRecordsForOwner: vi
      .fn()
      .mockResolvedValue([{ thread, turns: [turn] }]),
    findTurnForOwner: vi.fn().mockResolvedValue(turn),
    findTurnById: vi.fn().mockResolvedValue(turn),
    findContextTurns: vi.fn().mockResolvedValue([turn]),
    markRunning: vi.fn().mockResolvedValue({ ...turn, status: "running" }),
    markQueued: vi.fn(),
    markSucceeded: vi.fn(),
    markFailed: vi.fn(),
    retryFailedTurn: vi.fn(),
  };
  return {
    repository,
    service: new AssistantService(
      config,
      repository as unknown as AssistantRepository,
    ),
  };
}

describe("AssistantService", () => {
  it("defaults exactly to Gemini through OpenRouter and binds the owner", async () => {
    const { repository, service } = createService({ openRouter: true });
    await expect(
      service.createThread(
        { requestId: turn.requestId, content: "Hello" },
        "user_owner",
      ),
    ).resolves.toMatchObject({
      created: true,
      thread: { id: thread.id },
      turn: { model: "google/gemini-3.6-flash" },
    });
    expect(repository.createThreadWithTurn).toHaveBeenCalledWith({
      createdBy: "user_owner",
      requestId: turn.requestId,
      title: "Hello",
      model: "google/gemini-3.6-flash",
      effort: "low",
      content: "Hello",
    });
  });

  it("never silently substitutes an unavailable default or explicit model", async () => {
    const onlyOpenAi = createService({ openAi: true }).service;
    await expect(
      onlyOpenAi.createThread(
        { requestId: turn.requestId, content: "Hello" },
        "user_owner",
      ),
    ).rejects.toBeInstanceOf(AssistantProviderUnavailableError);

    const onlyOpenRouter = createService({ openRouter: true }).service;
    await expect(
      onlyOpenRouter.createThread(
        {
          requestId: turn.requestId,
          model: "openai/gpt-5.6-terra",
          content: "Hello",
        },
        "user_owner",
      ),
    ).rejects.toBeInstanceOf(AssistantProviderUnavailableError);
  });

  it("accepts Qwen3.7 Max only when OpenRouter is configured", async () => {
    const { repository, service } = createService({ openRouter: true });
    repository.createThreadWithTurn!.mockResolvedValue({
      created: true,
      thread,
      turn: { ...turn, model: "qwen/qwen3.7-max", effort: "high" },
    });

    await service.createThread(
      {
        requestId: turn.requestId,
        model: "qwen/qwen3.7-max",
        effort: "high",
        content: "Hello",
      },
      "user_owner",
    );

    expect(repository.createThreadWithTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "qwen/qwen3.7-max",
        effort: "high",
      }),
    );
  });

  it("returns an existing durable replay before checking current provider availability", async () => {
    const { repository, service } = createService();
    repository.findRequestForOwner!.mockResolvedValue({ thread, turn });

    await expect(
      service.createThread(
        { requestId: turn.requestId, content: "Hello" },
        "user_owner",
      ),
    ).resolves.toMatchObject({
      created: false,
      thread: { id: thread.id },
      turn: { id: turn.id, model: "google/gemini-3.6-flash", effort: "low" },
    });
    expect(repository.createThreadWithTurn).not.toHaveBeenCalled();
  });

  it("returns an existing append replay before checking current provider availability", async () => {
    const { repository, service } = createService();
    const appended = {
      ...turn,
      id: "1ee717e8-c80d-4239-a2a9-cd38515417e4",
      requestId: "4163e1ad-9223-43f5-9955-9a2aaf49aecc",
      sequence: 2,
      userContent: "Continue",
    };
    repository.findRequestForOwner!.mockResolvedValue({
      thread,
      turn: appended,
    });

    await expect(
      service.appendTurn(
        thread.id,
        { requestId: appended.requestId, content: "Continue" },
        "user_owner",
      ),
    ).resolves.toMatchObject({
      created: false,
      turn: { id: appended.id, effort: "low" },
    });
    expect(repository.appendTurn).not.toHaveBeenCalled();
  });

  it("rejects reuse of a request id with different content", async () => {
    const { service } = createService({ openRouter: true });
    await expect(
      service.createThread(
        { requestId: turn.requestId, content: "Different" },
        "user_owner",
      ),
    ).rejects.toBeInstanceOf(AssistantTurnConflictError);
  });

  it("scopes public reads by owner and hides cross-owner ids", async () => {
    const { repository, service } = createService({ openRouter: true });
    repository.findThreadRecordForOwner!.mockResolvedValueOnce(undefined);
    await expect(
      service.getThread(thread.id, "user_other"),
    ).rejects.toBeInstanceOf(AssistantThreadNotFoundError);
    expect(repository.findThreadRecordForOwner).toHaveBeenCalledWith(
      thread.id,
      "user_other",
    );
  });

  it("reconstructs only succeeded durable history plus the active user turn", async () => {
    const { repository, service } = createService({ openRouter: true });
    const first = {
      ...turn,
      status: "succeeded",
      assistantContent: "First answer",
      completedAt: new Date(),
    };
    const second = {
      ...turn,
      id: "1ee717e8-c80d-4239-a2a9-cd38515417e4",
      requestId: "4163e1ad-9223-43f5-9955-9a2aaf49aecc",
      sequence: 2,
      status: "running",
      userContent: "Continue",
      startedAt: new Date(),
    };
    repository.findTurnById!.mockResolvedValue(second);
    repository.markRunning!.mockResolvedValue(second);
    repository.findContextTurns!.mockResolvedValue([first, second]);

    await expect(service.start(second.id, 1)).resolves.toEqual({
      turn: second,
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "First answer" },
        { role: "user", content: "Continue" },
      ],
    });
  });

  it("fences stale job attempts before generation", async () => {
    const { repository, service } = createService({ openRouter: true });
    repository.findTurnById!.mockResolvedValue({ ...turn, attempt: 2 });
    await expect(service.start(turn.id, 1)).resolves.toEqual({
      turn: { ...turn, attempt: 2 },
      messages: [],
    });
    expect(repository.markRunning).not.toHaveBeenCalled();
  });
});
