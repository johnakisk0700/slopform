import type { ConfigService } from "@nestjs/config";
import type {
  AssistantThreadRow,
  AssistantTurnRow,
} from "@join-the-six/database";
import { describe, expect, it, vi } from "vitest";

import type { Environment } from "../../infrastructure/config/environment.js";
import {
  ConversationTerminalResultConflictError,
  type AssistantConversationSnapshot,
  type ConversationThreadRepository,
} from "../conversations/conversation-thread.repository.js";
import {
  CONVERSATION_THREAD_MAX_TURNS,
  type ConversationThreadDocument,
  type ConversationTurn,
} from "../conversations/conversation-thread.schemas.js";
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
  readonly conversations: Record<string, ReturnType<typeof vi.fn>>;
  readonly repository: Record<string, ReturnType<typeof vi.fn>>;
  readonly service: AssistantService;
  readonly setConversation: (
    conversation: ConversationThreadDocument | undefined,
  ) => void;
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
    listThreadTurnInventoriesForOwner: vi
      .fn()
      .mockResolvedValue([{ thread, turnIds: [turn.id] }]),
    findTurnForOwner: vi.fn().mockResolvedValue(turn),
    findTurnById: vi.fn().mockResolvedValue(turn),
    findContextTurns: vi.fn().mockResolvedValue([turn]),
    markRunning: vi.fn().mockResolvedValue({ ...turn, status: "running" }),
    markQueued: vi.fn(),
    markSucceeded: vi.fn(),
    markFailed: vi.fn(),
    retryFailedTurn: vi.fn(),
  };
  let storedConversation: ConversationThreadDocument | undefined;
  const conversations = {
    synchronizeAssistantThread: vi.fn(
      (snapshot: AssistantConversationSnapshot) => {
        const incoming = conversationFromSnapshot(snapshot);
        if (!storedConversation) {
          storedConversation = incoming;
        } else {
          const existingTurns = new Map(
            storedConversation.turns.map((item) => [item.id, item]),
          );
          const incomingIds = new Set(incoming.turns.map((item) => item.id));
          storedConversation = {
            ...storedConversation,
            turns: [
              ...incoming.turns.map(
                (item) => existingTurns.get(item.id) ?? item,
              ),
              ...storedConversation.turns.filter(
                (item) => !incomingIds.has(item.id),
              ),
            ].sort((left, right) => left.sequence - right.sequence),
          };
        }
        return Promise.resolve(storedConversation);
      },
    ),
    findAssistantThreadForOwner: vi.fn(() =>
      Promise.resolve(storedConversation),
    ),
    listAssistantThreadsForOwner: vi.fn(() =>
      Promise.resolve(storedConversation ? [storedConversation] : []),
    ),
    markTurnRunning: vi.fn((input: { turnId: string; startedAt: Date }) => {
      storedConversation = updateConversationTurn(
        storedConversation,
        input.turnId,
        {
          status: "running",
          startedAt: input.startedAt,
        },
      );
      return Promise.resolve(true);
    }),
    markTurnQueued: vi.fn().mockResolvedValue(true),
    markTurnSucceeded: vi.fn().mockResolvedValue(true),
    markTurnFailed: vi.fn().mockResolvedValue(true),
    prepareTurnRetry: vi.fn().mockResolvedValue(true),
  };
  return {
    conversations,
    repository,
    service: new AssistantService(
      config,
      repository as unknown as AssistantRepository,
      conversations as unknown as ConversationThreadRepository,
    ),
    setConversation: (conversation) => {
      storedConversation = conversation;
    },
  };
}

describe("AssistantService", () => {
  it("defaults exactly to Gemini through OpenRouter and binds the owner", async () => {
    const { conversations, repository, service } = createService({
      openRouter: true,
    });
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
    expect(conversations.synchronizeAssistantThread).toHaveBeenCalledWith(
      expect.objectContaining({
        id: thread.id,
        ownerId: "user_owner",
        turns: [
          expect.objectContaining({
            input: { actor: "admin", content: "Hello" },
          }),
        ],
      }),
    );
  });

  // Both halves used to be reached by naming an OpenAI-routed model; Terra now
  // routes OpenAI direct like Luna, so the "wrong provider funded" case uses a
  // Gemini turn instead. The rule under test is unchanged: the model's provider
  // must be funded before a turn is created, and a missing key is never quietly
  // worked around.
  it("never silently substitutes an unavailable default or explicit model", async () => {
    const noProviders = createService().service;
    await expect(
      noProviders.createThread(
        { requestId: turn.requestId, content: "Hello" },
        "user_owner",
      ),
    ).rejects.toBeInstanceOf(AssistantProviderUnavailableError);

    const onlyOpenAi = createService({ openAi: true }).service;
    await expect(
      onlyOpenAi.createThread(
        {
          requestId: "a8e94f93-9909-4cf2-b580-3b55c287a453",
          model: "google/gemini-3.6-flash",
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
      enqueueRequired: true,
      thread: { id: thread.id },
      turn: { id: turn.id, model: "google/gemini-3.6-flash", effort: "low" },
    });
    expect(repository.createThreadWithTurn).not.toHaveBeenCalled();
  });

  it("uses MongoDB for public reads after materialization", async () => {
    const { repository, service } = createService({ openRouter: true });
    await service.createThread(
      { requestId: turn.requestId, content: "Hello" },
      "user_owner",
    );
    repository.findThreadRecordForOwner!.mockClear();

    await expect(
      service.getThread(thread.id, "user_owner"),
    ).resolves.toMatchObject({
      id: thread.id,
      turns: [{ user: { content: "Hello" } }],
    });
    expect(repository.findThreadRecordForOwner).not.toHaveBeenCalled();
  });

  it("lists from compact MongoDB summaries without reloading full PostgreSQL content", async () => {
    const { repository, service } = createService({ openRouter: true });
    await service.createThread(
      { requestId: turn.requestId, content: "Hello" },
      "user_owner",
    );
    repository.findThreadRecordForOwner!.mockClear();

    await expect(service.list("user_owner")).resolves.toEqual({
      items: [
        expect.objectContaining({
          id: thread.id,
          lastModel: "google/gemini-3.6-flash",
          lastStatus: "queued",
        }),
      ],
    });
    expect(repository.findThreadRecordForOwner).not.toHaveBeenCalled();
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
    repository.findThreadRecordForOwner!.mockResolvedValue({
      thread,
      turns: [turn, appended],
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

  it("passes the aggregate capacity into the locked PostgreSQL append", async () => {
    const { repository, service } = createService({ openRouter: true });
    await service.createThread(
      { requestId: turn.requestId, content: "Hello" },
      "user_owner",
    );
    const appended = {
      ...turn,
      id: "1ee717e8-c80d-4239-a2a9-cd38515417e4",
      requestId: "4163e1ad-9223-43f5-9955-9a2aaf49aecc",
      sequence: 2,
      userContent: "Continue",
    };
    repository.appendTurn!.mockResolvedValue({
      created: true,
      thread,
      turn: appended,
    });
    repository.findThreadRecordForOwner!.mockResolvedValue({
      thread,
      turns: [turn, appended],
    });

    await service.appendTurn(
      thread.id,
      { requestId: appended.requestId, content: "Continue" },
      "user_owner",
    );

    expect(repository.appendTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        maximumTurns: CONVERSATION_THREAD_MAX_TURNS,
      }),
    );
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
    repository.findThreadRecordForOwner!.mockResolvedValue({
      thread,
      turns: [first, second],
    });

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

  it("does not mutate MongoDB when PostgreSQL rejects a non-latest retry", async () => {
    const { conversations, repository, service } = createService({
      openRouter: true,
    });
    const failed = {
      ...turn,
      status: "failed",
      errorCode: "generation_failed",
      errorMessage: "Failed",
      completedAt: new Date("2026-07-23T10:01:00.000Z"),
      updatedAt: new Date("2026-07-23T10:01:00.000Z"),
    };
    const failedThread = {
      ...thread,
      updatedAt: failed.updatedAt,
    };
    repository.createThreadWithTurn!.mockResolvedValue({
      created: true,
      thread: failedThread,
      turn: failed,
    });
    repository.findThreadRecordForOwner!.mockResolvedValue({
      thread: failedThread,
      turns: [failed],
    });
    repository.findTurnForOwner!.mockResolvedValue(failed);
    repository.retryFailedTurn!.mockResolvedValue(undefined);
    await service.createThread(
      { requestId: turn.requestId, content: "Hello" },
      "user_owner",
    );
    conversations.prepareTurnRetry!.mockClear();

    await expect(
      service.retryTurn(thread.id, turn.id, "user_owner"),
    ).rejects.toBeInstanceOf(AssistantTurnConflictError);
    expect(conversations.prepareTurnRetry).not.toHaveBeenCalled();
  });

  it("does not advance the PostgreSQL projection when MongoDB rejects a stale finalizer", async () => {
    const { conversations, repository, service } = createService({
      openRouter: true,
    });
    await service.createThread(
      { requestId: turn.requestId, content: "Hello" },
      "user_owner",
    );
    repository.findTurnById!.mockResolvedValue({ ...turn, status: "running" });
    conversations.markTurnSucceeded!.mockResolvedValue(false);

    await service.markSucceeded(turn.id, 1, "Answer");

    expect(repository.markSucceeded).not.toHaveBeenCalled();
  });

  it("materializes a missing MongoDB turn before stale recovery marks it failed", async () => {
    const { conversations, repository, service } = createService({
      openRouter: true,
    });
    repository.findTurnById!.mockResolvedValue(turn);

    await service.markFailed(
      turn.id,
      turn.attempt,
      "generation_failed",
      "Interrupted",
    );

    expect(conversations.synchronizeAssistantThread).toHaveBeenCalledOnce();
    expect(conversations.markTurnFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: thread.id,
        turnId: turn.id,
        attempt: turn.attempt,
      }),
    );
  });

  it("repairs an interrupted retry before stale recovery fails the new attempt", async () => {
    const harness = createService({ openRouter: true });
    const failedAttempt = failedTurnRow(1, "Original failure");
    const queuedRetry = queuedTurnRow(2);
    harness.setConversation(conversationFromRows([failedAttempt]));
    harness.repository.findTurnById!.mockResolvedValue(queuedRetry);
    harness.repository.findThreadRecordForOwner!.mockResolvedValue({
      thread: { ...thread, updatedAt: queuedRetry.updatedAt },
      turns: [queuedRetry],
    });
    harness.repository.markFailed!.mockResolvedValue(true);
    harness.conversations.prepareTurnRetry!.mockImplementation(
      (input: { attempt: number }) => {
        expect(input.attempt).toBe(2);
        harness.setConversation(conversationFromRows([queuedRetry]));
        return Promise.resolve(true);
      },
    );

    await expect(
      harness.service.markFailed(
        turn.id,
        2,
        "generation_failed",
        "Interrupted",
      ),
    ).resolves.toBe(true);

    expect(harness.conversations.prepareTurnRetry).toHaveBeenCalledOnce();
    expect(harness.conversations.markTurnFailed).toHaveBeenCalledWith(
      expect.objectContaining({ turnId: turn.id, attempt: 2 }),
    );
    expect(harness.repository.markFailed).toHaveBeenCalledWith(
      turn.id,
      2,
      "generation_failed",
      "Interrupted",
    );
    expect(
      harness.conversations.prepareTurnRetry!.mock.invocationCallOrder[0],
    ).toBeLessThan(
      harness.conversations.markTurnFailed!.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("returns the reconciled retry attempt when the original request is replayed", async () => {
    const harness = createService({ openRouter: true });
    const failedAttempt = failedTurnRow(1, "Original failure");
    const queuedRetry = queuedTurnRow(2);
    harness.setConversation(conversationFromRows([failedAttempt]));
    harness.repository.findRequestForOwner!.mockResolvedValue({
      thread,
      turn: queuedRetry,
    });
    harness.repository.findThreadRecordForOwner!.mockResolvedValue({
      thread: { ...thread, updatedAt: queuedRetry.updatedAt },
      turns: [queuedRetry],
    });
    harness.conversations.prepareTurnRetry!.mockImplementation(() => {
      harness.setConversation(conversationFromRows([queuedRetry]));
      return Promise.resolve(true);
    });

    await expect(
      harness.service.createThread(
        { requestId: turn.requestId, content: "Hello" },
        "user_owner",
      ),
    ).resolves.toMatchObject({
      created: false,
      enqueueRequired: true,
      turn: { id: turn.id, attempt: 2, status: "queued" },
    });
  });

  it("repairs PostgreSQL from a terminal MongoDB result that wins a finalizer race", async () => {
    const harness = createService({ openRouter: true });
    const running = {
      ...turn,
      status: "running",
      startedAt: new Date("2026-07-23T10:00:30.000Z"),
    };
    const authoritative = failedTurnRow(1, "Authoritative failure");
    harness.setConversation(conversationFromRows([running]));
    harness.repository.findTurnById!.mockResolvedValue(running);
    harness.repository.findThreadRecordForOwner!.mockResolvedValue({
      thread,
      turns: [running],
    });
    harness.repository.markFailed!.mockResolvedValue(true);
    harness.conversations.markTurnFailed!.mockImplementation(() => {
      harness.setConversation(conversationFromRows([authoritative]));
      return Promise.reject(new ConversationTerminalResultConflictError());
    });

    await expect(
      harness.service.markFailed(
        turn.id,
        1,
        "generation_failed",
        "Interrupted",
      ),
    ).resolves.toBe(false);

    expect(harness.repository.markFailed).toHaveBeenCalledWith(
      turn.id,
      1,
      "generation_failed",
      "Authoritative failure",
    );
  });

  it("repairs PostgreSQL from an authoritative succeeded result after a response race", async () => {
    const harness = createService({ openRouter: true });
    const running = {
      ...turn,
      status: "running",
      startedAt: new Date("2026-07-23T10:00:30.000Z"),
    };
    const authoritative = succeededTurnRow("Authoritative answer");
    harness.setConversation(conversationFromRows([authoritative]));
    harness.repository.findTurnById!.mockResolvedValue(running);
    harness.repository.markSucceeded!.mockResolvedValue(undefined);
    harness.conversations.markTurnSucceeded!.mockRejectedValue(
      new ConversationTerminalResultConflictError(),
    );

    await harness.service.markSucceeded(turn.id, 1, "Different answer");

    expect(harness.repository.markSucceeded).toHaveBeenCalledWith(
      turn.id,
      1,
      "Authoritative answer",
    );
  });
});

function conversationFromSnapshot(
  snapshot: AssistantConversationSnapshot,
): ConversationThreadDocument {
  return {
    _id: snapshot.id,
    schemaVersion: 1,
    purpose: "admin_assistant",
    channel: "admin",
    owner: { type: "staff", id: snapshot.ownerId },
    title: snapshot.title,
    state: "active",
    goals: [],
    humanTakeover: {
      status: "inactive",
      requestedAt: null,
      resolvedAt: null,
    },
    turns: [...snapshot.turns],
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
  };
}

function updateConversationTurn(
  conversation: ConversationThreadDocument | undefined,
  turnId: string,
  patch: Partial<ConversationThreadDocument["turns"][number]>,
): ConversationThreadDocument | undefined {
  if (!conversation) {
    return undefined;
  }
  return {
    ...conversation,
    turns: conversation.turns.map((item) =>
      item.id === turnId ? { ...item, ...patch } : item,
    ),
  };
}

function queuedTurnRow(attempt: number): AssistantTurnRow {
  return {
    ...turn,
    status: "queued",
    attempt,
    assistantContent: null,
    errorCode: null,
    errorMessage: null,
    startedAt: null,
    completedAt: null,
    updatedAt: new Date(`2026-07-23T10:0${attempt}:00.000Z`),
  };
}

function failedTurnRow(attempt: number, message: string): AssistantTurnRow {
  const completedAt = new Date(`2026-07-23T10:0${attempt}:30.000Z`);
  return {
    ...queuedTurnRow(attempt),
    status: "failed",
    errorCode: "generation_failed",
    errorMessage: message,
    completedAt,
    updatedAt: completedAt,
  };
}

function succeededTurnRow(response: string): AssistantTurnRow {
  const completedAt = new Date("2026-07-23T10:01:30.000Z");
  return {
    ...queuedTurnRow(1),
    status: "succeeded",
    assistantContent: response,
    startedAt: new Date("2026-07-23T10:00:30.000Z"),
    completedAt,
    updatedAt: completedAt,
  };
}

function conversationFromRows(
  rows: readonly AssistantTurnRow[],
): ConversationThreadDocument {
  const updatedAt =
    rows.reduce(
      (latest, row) => (row.updatedAt > latest ? row.updatedAt : latest),
      thread.updatedAt,
    ) ?? thread.updatedAt;
  return conversationFromSnapshot({
    id: thread.id,
    ownerId: thread.createdBy,
    title: thread.title,
    createdAt: thread.createdAt,
    updatedAt,
    turns: rows.map<ConversationTurn>((row) => {
      const status = toConversationTurnStatus(row.status);
      return {
        id: row.id,
        requestId: row.requestId,
        sequence: row.sequence,
        status,
        attempt: row.attempt,
        model: row.model,
        reasoningEffort: row.effort,
        input: { actor: "admin", content: row.userContent },
        output:
          status === "succeeded" && row.assistantContent
            ? { actor: "assistant", content: row.assistantContent }
            : null,
        error:
          status === "failed" && row.errorCode && row.errorMessage
            ? { code: row.errorCode, message: row.errorMessage }
            : null,
        createdAt: row.createdAt,
        startedAt: row.startedAt,
        completedAt: row.completedAt,
      };
    }),
  });
}

function toConversationTurnStatus(status: string): ConversationTurn["status"] {
  if (
    status === "queued" ||
    status === "running" ||
    status === "succeeded" ||
    status === "failed"
  ) {
    return status;
  }
  throw new Error(`Unexpected assistant turn status: ${status}`);
}
