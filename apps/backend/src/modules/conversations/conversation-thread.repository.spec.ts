import type { Collection } from "mongodb";
import { MongoServerError } from "mongodb";
import { describe, expect, it, vi } from "vitest";

import type { MongoService } from "../../infrastructure/mongo/mongo.service.js";
import {
  ConversationTerminalResultConflictError,
  ConversationThreadRepository,
  type AssistantConversationSnapshot,
} from "./conversation-thread.repository.js";
import type {
  ConversationThreadDocument,
  ConversationTurn,
} from "./conversation-thread.schemas.js";

const threadId = "66de52a8-1a26-4cbb-b8d1-fcf8bdc2dd51";
const firstTurnId = "7c57f3b8-2b13-48f5-8730-18ac71f490cd";
const secondTurnId = "1ee717e8-c80d-4239-a2a9-cd38515417e4";
const firstRequestId = "a8e94f93-9909-4cf2-b580-3b55c287a452";
const secondRequestId = "4163e1ad-9223-43f5-9955-9a2aaf49aecc";
const createdAt = new Date("2026-07-25T10:00:00.000Z");
const completedAt = new Date("2026-07-25T10:01:00.000Z");

describe("ConversationThreadRepository", () => {
  it("projects compact turn metadata for thread lists", async () => {
    const cursor = {
      sort: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      toArray: vi.fn().mockResolvedValue([
        {
          _id: threadId,
          title: "Conversation",
          turns: [
            {
              id: firstTurnId,
              sequence: 1,
              status: "queued",
              model: "google/gemini-3.6-flash",
            },
          ],
          createdAt,
          updatedAt: completedAt,
        },
      ]),
    };
    const collection = collectionMock({
      find: vi.fn().mockReturnValue(cursor),
    });
    const repository = createRepository(collection);

    await expect(
      repository.listAssistantThreadsForOwner("user_owner"),
    ).resolves.toEqual([
      expect.objectContaining({
        _id: threadId,
        turns: [
          expect.objectContaining({
            id: firstTurnId,
            status: "queued",
          }),
        ],
      }),
    ]);
    expect(collection.find).toHaveBeenCalledWith(
      expect.objectContaining({ "owner.id": "user_owner" }),
      {
        projection: {
          _id: 1,
          title: 1,
          "turns.id": 1,
          "turns.sequence": 1,
          "turns.status": 1,
          "turns.model": 1,
          createdAt: 1,
          updatedAt: 1,
        },
      },
    );
  });

  it("synchronizes only missing turns and preserves MongoDB terminal content", async () => {
    const mongoAnswer = succeededTurn("MongoDB is authoritative.");
    const existing = assistantConversation([mongoAnswer]);
    const appended = queuedTurn(2);
    const synchronized = assistantConversation([mongoAnswer, appended]);
    const collection = collectionMock({
      insertOne: vi.fn().mockRejectedValue(duplicateKeyError()),
      findOne: vi
        .fn()
        .mockResolvedValueOnce(existing)
        .mockResolvedValueOnce(synchronized),
      updateOne: vi
        .fn()
        .mockResolvedValue({ matchedCount: 1, modifiedCount: 1 }),
    });
    const repository = createRepository(collection);

    const result = await repository.synchronizeAssistantThread({
      ...snapshot([
        {
          ...mongoAnswer,
          output: { actor: "assistant", content: "Stale PostgreSQL copy." },
        },
        appended,
      ]),
    });

    expect(result.turns[0]?.output?.content).toBe("MongoDB is authoritative.");
    expect(collection.createIndexes).toHaveBeenCalledWith([
      {
        name: "conversation_owner_purpose_updated_idx",
        key: {
          "owner.type": 1,
          "owner.id": 1,
          purpose: 1,
          updatedAt: -1,
        },
      },
      {
        name: "conversation_purpose_state_updated_idx",
        key: { purpose: 1, state: 1, updatedAt: 1 },
      },
    ]);
    expect(collection.updateOne).toHaveBeenCalledOnce();
    expect(collection.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: threadId,
        "owner.id": "user_owner",
        "turns.id": { $ne: secondTurnId },
        "turns.sequence": { $ne: 2 },
      }),
      expect.objectContaining({ $push: { turns: appended } }),
    );
  });

  it("fences state transitions by owner, status and exact attempt", async () => {
    const collection = collectionMock({
      updateOne: vi
        .fn()
        .mockResolvedValue({ matchedCount: 1, modifiedCount: 1 }),
    });
    const repository = createRepository(collection);

    await expect(
      repository.markTurnSucceeded({
        threadId,
        ownerId: "user_owner",
        turnId: firstTurnId,
        attempt: 2,
        response: "Answer",
        completedAt,
      }),
    ).resolves.toBe(true);

    expect(collection.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: threadId,
        "owner.id": "user_owner",
        turns: {
          $elemMatch: {
            id: firstTurnId,
            attempt: 2,
            status: { $in: ["queued", "running"] },
          },
        },
      }),
      expect.any(Object),
      {
        arrayFilters: [
          {
            "turn.id": firstTurnId,
            "turn.attempt": 2,
            "turn.status": { $in: ["queued", "running"] },
          },
        ],
      },
    );
  });

  it("returns a fenced no-op for a stale attempt", async () => {
    const current = { ...queuedTurn(1), attempt: 2 };
    const collection = collectionMock({
      updateOne: vi
        .fn()
        .mockResolvedValue({ matchedCount: 0, modifiedCount: 0 }),
      findOne: vi.fn().mockResolvedValue({ turns: [current] }),
    });
    const repository = createRepository(collection);

    await expect(
      repository.markTurnFailed({
        threadId,
        ownerId: "user_owner",
        turnId: firstTurnId,
        attempt: 1,
        code: "generation_failed",
        message: "Interrupted",
        completedAt,
      }),
    ).resolves.toBe(false);
  });

  it("rejects a conflicting terminal result for the same attempt", async () => {
    const collection = collectionMock({
      updateOne: vi
        .fn()
        .mockResolvedValue({ matchedCount: 0, modifiedCount: 0 }),
      findOne: vi
        .fn()
        .mockResolvedValue({ turns: [succeededTurn("First answer")] }),
    });
    const repository = createRepository(collection);

    await expect(
      repository.markTurnSucceeded({
        threadId,
        ownerId: "user_owner",
        turnId: firstTurnId,
        attempt: 1,
        response: "Different answer",
        completedAt,
      }),
    ).rejects.toBeInstanceOf(ConversationTerminalResultConflictError);
  });

  it("rejects an invalid terminal error before issuing a MongoDB mutation", async () => {
    const collection = collectionMock({});
    const repository = createRepository(collection);

    await expect(
      repository.markTurnFailed({
        threadId,
        ownerId: "user_owner",
        turnId: firstTurnId,
        attempt: 1,
        code: "generation_failed",
        message: " ",
        completedAt,
      }),
    ).rejects.toThrow();
    expect(collection.updateOne).not.toHaveBeenCalled();
  });

  it("rejects oversized provider output before issuing a MongoDB mutation", async () => {
    const collection = collectionMock({});
    const repository = createRepository(collection);

    await expect(
      repository.markTurnSucceeded({
        threadId,
        ownerId: "user_owner",
        turnId: firstTurnId,
        attempt: 1,
        response: "x".repeat(20_001),
        completedAt,
      }),
    ).rejects.toThrow();
    expect(collection.updateOne).not.toHaveBeenCalled();
  });

  it("retries from the previous attempt and accepts an idempotent queued replay", async () => {
    const queuedRetry = { ...queuedTurn(1), attempt: 2 };
    const collection = collectionMock({
      updateOne: vi
        .fn()
        .mockResolvedValue({ matchedCount: 0, modifiedCount: 0 }),
      findOne: vi.fn().mockResolvedValue({ turns: [queuedRetry] }),
    });
    const repository = createRepository(collection);

    await expect(
      repository.prepareTurnRetry({
        threadId,
        ownerId: "user_owner",
        turnId: firstTurnId,
        attempt: 2,
      }),
    ).resolves.toBe(true);
    expect(collection.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        turns: {
          $elemMatch: {
            id: firstTurnId,
            attempt: 1,
            status: { $in: ["failed"] },
          },
        },
      }),
      expect.any(Object),
      expect.any(Object),
    );
  });
});

function createRepository(
  collection: Partial<Collection<ConversationThreadDocument>>,
): ConversationThreadRepository {
  const mongo = {
    collection: vi.fn().mockResolvedValue(collection),
    ping: vi.fn().mockResolvedValue(undefined),
  } as unknown as MongoService;
  return new ConversationThreadRepository(mongo);
}

function collectionMock(
  overrides: Partial<Collection<ConversationThreadDocument>>,
): Collection<ConversationThreadDocument> & {
  readonly findOne: ReturnType<typeof vi.fn>;
  readonly find: ReturnType<typeof vi.fn>;
  readonly insertOne: ReturnType<typeof vi.fn>;
  readonly updateOne: ReturnType<typeof vi.fn>;
} {
  return {
    createIndexes: vi.fn().mockResolvedValue([]),
    find: vi.fn(),
    findOne: vi.fn(),
    insertOne: vi.fn().mockResolvedValue({ acknowledged: true }),
    updateOne: vi.fn().mockResolvedValue({ matchedCount: 1, modifiedCount: 1 }),
    ...overrides,
  } as unknown as Collection<ConversationThreadDocument> & {
    readonly find: ReturnType<typeof vi.fn>;
    readonly findOne: ReturnType<typeof vi.fn>;
    readonly insertOne: ReturnType<typeof vi.fn>;
    readonly updateOne: ReturnType<typeof vi.fn>;
  };
}

function duplicateKeyError(): MongoServerError {
  return new MongoServerError({
    ok: 0,
    code: 11_000,
    errmsg: "duplicate key",
  });
}

function snapshot(turns: ConversationTurn[]): AssistantConversationSnapshot {
  return {
    id: threadId,
    ownerId: "user_owner",
    title: "Conversation",
    turns,
    createdAt,
    updatedAt: completedAt,
  };
}

function assistantConversation(
  turns: ConversationTurn[],
): ConversationThreadDocument {
  return {
    _id: threadId,
    schemaVersion: 1,
    purpose: "admin_assistant",
    channel: "admin",
    owner: { type: "staff", id: "user_owner" },
    title: "Conversation",
    state: "active",
    goals: [],
    humanTakeover: {
      status: "inactive",
      requestedAt: null,
      resolvedAt: null,
    },
    turns,
    createdAt,
    updatedAt: completedAt,
  };
}

function queuedTurn(sequence: 1 | 2): ConversationTurn {
  return {
    id: sequence === 1 ? firstTurnId : secondTurnId,
    requestId: sequence === 1 ? firstRequestId : secondRequestId,
    sequence,
    status: "queued",
    attempt: 1,
    model: "google/gemini-3.6-flash",
    reasoningEffort: "low",
    serviceTier: "standard",
    input: { actor: "admin", content: `Question ${sequence}` },
    output: null,
    partial: null,
    reasoning: null,
    error: null,
    createdAt,
    startedAt: null,
    completedAt: null,
  };
}

function succeededTurn(response: string): ConversationTurn {
  return {
    ...queuedTurn(1),
    status: "succeeded",
    output: { actor: "assistant", content: response },
    startedAt: createdAt,
    completedAt,
  };
}
