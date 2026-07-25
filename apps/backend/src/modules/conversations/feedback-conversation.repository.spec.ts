import { randomUUID } from "node:crypto";

import type { Collection } from "mongodb";
import { MongoServerError } from "mongodb";
import { describe, expect, it, vi } from "vitest";

import type { MongoService } from "../../infrastructure/mongo/mongo.service.js";
import { ConversationPersistenceError } from "./conversation-persistence.errors.js";
import {
  FeedbackConversationCapacityError,
  FeedbackConversationNotFoundError,
  FeedbackConversationPhoneConflictError,
  FeedbackConversationRepository,
  FeedbackConversationTransitionError,
} from "./feedback-conversation.repository.js";
import {
  FEEDBACK_CONVERSATION_MAX_MESSAGES,
  type FeedbackConversationDocument,
  type FeedbackConversationMessage,
  buildFeedbackConversationGoals,
  deriveFeedbackConversationId,
} from "./feedback-conversation.schemas.js";

const campaignId = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const respondentParticipantId = "9f3c1a52-6e2b-4b4a-9a17-2cb2a6d13a55";
const conversationId = deriveFeedbackConversationId(
  campaignId,
  respondentParticipantId,
);
const phoneAtLaunch = "+306900000000";
const launchedAt = new Date("2026-07-25T10:00:00.000Z");
const repliedAt = new Date("2026-07-25T10:05:00.000Z");
const ingressId = "b1c9e0a4-2c65-4a29-9a2e-2d0a3f2e1b77";
const outboxId = "d4a4b3c2-8f1e-4d3c-9b2a-1e0f9d8c7b6a";

describe("FeedbackConversationRepository", () => {
  it("creates the launch document under a deterministic id and reviewed indexes", async () => {
    const collection = collectionMock({});
    const repository = createRepository(collection);

    const result = await repository.createFromLaunch({
      campaignId,
      respondentParticipantId,
      phoneAtLaunch,
      launchedAt,
    });

    expect(result).toEqual({
      created: true,
      conversation: expect.objectContaining({
        _id: conversationId,
        schemaVersion: 2,
        purpose: "post_event_feedback",
        channel: "whatsapp",
        lifecycle: { state: "open", reason: null, closedAt: null },
        control: { mode: "bot", source: "launch", changedAt: launchedAt },
        extraction: { cursorSeq: 0, lastRunAt: null, model: null },
        needsAttention: false,
      }),
    });
    expect(result.conversation.goals.map((goal) => goal.key)).toEqual([
      "event_score",
      "liked",
      "meet_again",
      "avoid",
    ]);
    expect(collection.createIndexes).toHaveBeenCalledWith([
      {
        name: "feedback_conversation_open_phone_unique_idx",
        key: { phoneAtLaunch: 1 },
        unique: true,
        partialFilterExpression: {
          purpose: "post_event_feedback",
          "lifecycle.state": "open",
        },
      },
      {
        name: "feedback_conversation_campaign_updated_idx",
        key: { campaignId: 1, updatedAt: -1 },
      },
    ]);
  });

  it("replays a launch idempotently and never recreates a stopped conversation", async () => {
    const stopped = feedbackConversation({
      lifecycle: {
        state: "closed",
        reason: "stopped",
        closedAt: repliedAt,
      },
    });
    const collection = collectionMock({
      insertOne: vi.fn().mockRejectedValue(duplicateKeyError()),
      findOne: vi.fn().mockResolvedValue(stopped),
    });
    const repository = createRepository(collection);

    await expect(
      repository.createFromLaunch({
        campaignId,
        respondentParticipantId,
        phoneAtLaunch,
        launchedAt,
      }),
    ).resolves.toEqual({
      created: false,
      conversation: expect.objectContaining({
        lifecycle: expect.objectContaining({ reason: "stopped" }),
      }),
    });
  });

  it("reports a phone conflict when another open conversation owns the number", async () => {
    const collection = collectionMock({
      insertOne: vi.fn().mockRejectedValue(duplicateKeyError()),
      findOne: vi.fn().mockResolvedValue(null),
    });
    const repository = createRepository(collection);

    await expect(
      repository.createFromLaunch({
        campaignId,
        respondentParticipantId,
        phoneAtLaunch,
        launchedAt,
      }),
    ).rejects.toBeInstanceOf(FeedbackConversationPhoneConflictError);
  });

  it("resolves inbound traffic through the open-phone index", async () => {
    const collection = collectionMock({
      findOne: vi.fn().mockResolvedValue(feedbackConversation({})),
    });
    const repository = createRepository(collection);

    await expect(repository.findOpenByPhone(phoneAtLaunch)).resolves.toEqual(
      expect.objectContaining({ _id: conversationId }),
    );
    expect(collection.findOne).toHaveBeenCalledWith({
      schemaVersion: 2,
      purpose: "post_event_feedback",
      "lifecycle.state": "open",
      phoneAtLaunch,
    });
  });

  it("appends a message with a contiguous sequence fenced by the current size", async () => {
    const collection = collectionMock({
      findOne: vi
        .fn()
        .mockResolvedValue(feedbackConversation({ messages: [botMessage(1)] })),
    });
    const repository = createRepository(collection);

    const result = await repository.appendMessage({
      conversationId,
      actor: "participant",
      text: "Πέρασα τέλεια!",
      at: repliedAt,
      ingressId,
      providerMessageId: "wamid.1",
    });

    expect(result.appended).toBe(true);
    expect(result.message).toEqual(
      expect.objectContaining({ seq: 2, actor: "participant", ingressId }),
    );
    expect(result.conversation.messages).toHaveLength(2);
    expect(collection.updateOne).toHaveBeenCalledWith(
      {
        _id: conversationId,
        schemaVersion: 2,
        purpose: "post_event_feedback",
        messages: { $size: 1 },
      },
      {
        $push: { messages: result.message },
        $max: { updatedAt: repliedAt },
      },
    );
  });

  it("treats a replayed ingress append as an idempotent no-op", async () => {
    const existing = { ...participantMessage(1), ingressId };
    const collection = collectionMock({
      findOne: vi
        .fn()
        .mockResolvedValue(feedbackConversation({ messages: [existing] })),
    });
    const repository = createRepository(collection);

    const result = await repository.appendMessage({
      conversationId,
      actor: "participant",
      text: existing.text,
      at: repliedAt,
      ingressId,
    });

    expect(result).toEqual(
      expect.objectContaining({ appended: false, message: existing }),
    );
    expect(collection.updateOne).not.toHaveBeenCalled();
  });

  it("rejects a replayed provenance id carrying different content", async () => {
    const existing = { ...participantMessage(1), ingressId };
    const collection = collectionMock({
      findOne: vi
        .fn()
        .mockResolvedValue(feedbackConversation({ messages: [existing] })),
    });
    const repository = createRepository(collection);

    await expect(
      repository.appendMessage({
        conversationId,
        actor: "participant",
        text: "Something else entirely",
        at: repliedAt,
        ingressId,
      }),
    ).rejects.toBeInstanceOf(ConversationPersistenceError);
  });

  it("requires an idempotency key before touching MongoDB", async () => {
    const collection = collectionMock({});
    const repository = createRepository(collection);

    await expect(
      repository.appendMessage({
        conversationId,
        actor: "system",
        text: "Campaign paused",
        at: repliedAt,
      }),
    ).rejects.toThrow(/ingress id, an outbox id or a stable id/);
    expect(collection.updateOne).not.toHaveBeenCalled();
  });

  it("flags attention instead of dropping a message at the transcript cap", async () => {
    const messages = Array.from(
      { length: FEEDBACK_CONVERSATION_MAX_MESSAGES },
      (_, index) => participantMessage(index + 1),
    );
    const full = feedbackConversation({ messages });
    const collection = collectionMock({
      findOne: vi.fn().mockResolvedValue(full),
      findOneAndUpdate: vi
        .fn()
        .mockResolvedValue({ ...full, needsAttention: true }),
    });
    const repository = createRepository(collection);

    await expect(
      repository.appendMessage({
        conversationId,
        actor: "participant",
        text: "One message too many",
        at: repliedAt,
        ingressId,
      }),
    ).rejects.toBeInstanceOf(FeedbackConversationCapacityError);
    expect(collection.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ needsAttention: false }),
      expect.objectContaining({ $set: { needsAttention: true } }),
      { returnDocument: "after" },
    );
    expect(collection.updateOne).not.toHaveBeenCalled();
  });

  it("takes over from bot control and records the control source", async () => {
    const collection = collectionMock({
      findOneAndUpdate: vi.fn().mockResolvedValue(
        feedbackConversation({
          control: {
            mode: "human",
            source: "external_outbound",
            changedAt: repliedAt,
          },
        }),
      ),
    });
    const repository = createRepository(collection);

    const result = await repository.takeOver({
      conversationId,
      source: "external_outbound",
      at: repliedAt,
    });

    expect(result.changed).toBe(true);
    expect(result.conversation.control.mode).toBe("human");
    expect(collection.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: conversationId,
        "control.mode": "bot",
      }),
      {
        $set: {
          control: {
            mode: "human",
            source: "external_outbound",
            changedAt: repliedAt,
          },
        },
        $max: { updatedAt: repliedAt },
      },
      { returnDocument: "after" },
    );
  });

  it("reports an unchanged takeover when human control is already active", async () => {
    const human = feedbackConversation({
      control: { mode: "human", source: "staff_action", changedAt: repliedAt },
    });
    const collection = collectionMock({
      findOneAndUpdate: vi.fn().mockResolvedValue(null),
      findOne: vi.fn().mockResolvedValue(human),
    });
    const repository = createRepository(collection);

    await expect(
      repository.takeOver({
        conversationId,
        source: "staff_action",
        at: repliedAt,
      }),
    ).resolves.toEqual(expect.objectContaining({ changed: false }));
  });

  it("never resumes bot control on a closed conversation", async () => {
    const stopped = feedbackConversation({
      lifecycle: { state: "closed", reason: "stopped", closedAt: repliedAt },
      control: { mode: "human", source: "staff_action", changedAt: repliedAt },
    });
    const collection = collectionMock({
      findOneAndUpdate: vi.fn().mockResolvedValue(null),
      findOne: vi.fn().mockResolvedValue(stopped),
    });
    const repository = createRepository(collection);

    await expect(
      repository.resumeBot({ conversationId, at: repliedAt }),
    ).rejects.toBeInstanceOf(FeedbackConversationTransitionError);
    expect(collection.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        "control.mode": "human",
        "lifecycle.state": "open",
      }),
      expect.any(Object),
      { returnDocument: "after" },
    );
  });

  it("lets STOP override a softer terminal reason but never the reverse", async () => {
    const stopped = feedbackConversation({
      lifecycle: { state: "closed", reason: "stopped", closedAt: repliedAt },
    });
    const collection = collectionMock({
      findOneAndUpdate: vi.fn().mockResolvedValue(stopped),
    });
    const repository = createRepository(collection);

    await expect(
      repository.close({ conversationId, reason: "stopped", at: repliedAt }),
    ).resolves.toEqual(expect.objectContaining({ changed: true }));
    expect(collection.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        "lifecycle.reason": { $ne: "stopped" },
      }),
      expect.objectContaining({
        $set: {
          lifecycle: {
            state: "closed",
            reason: "stopped",
            closedAt: repliedAt,
          },
        },
      }),
      { returnDocument: "after" },
    );

    const closing = collectionMock({
      findOneAndUpdate: vi.fn().mockResolvedValue(null),
      findOne: vi.fn().mockResolvedValue(stopped),
    });
    const closingRepository = createRepository(closing);

    await expect(
      closingRepository.close({
        conversationId,
        reason: "completed",
        at: repliedAt,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        changed: false,
        conversation: expect.objectContaining({
          lifecycle: expect.objectContaining({ reason: "stopped" }),
        }),
      }),
    );
    expect(closing.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ "lifecycle.state": "open" }),
      expect.any(Object),
      { returnDocument: "after" },
    );
  });

  it("advances the extraction cursor only forward and only inside the transcript", async () => {
    const conversation = feedbackConversation({
      messages: [botMessage(1), participantMessage(2)],
      extraction: { cursorSeq: 2, lastRunAt: repliedAt, model: null },
    });
    const collection = collectionMock({
      findOneAndUpdate: vi.fn().mockResolvedValue(null),
      findOne: vi.fn().mockResolvedValue(conversation),
    });
    const repository = createRepository(collection);

    await expect(
      repository.advanceCursor({
        conversationId,
        toSeq: 2,
        at: repliedAt,
        model: "google/gemini-3.6-flash",
      }),
    ).resolves.toEqual(expect.objectContaining({ changed: false }));
    expect(collection.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        "extraction.cursorSeq": { $lt: 2 },
        $expr: { $lte: [2, { $size: "$messages" }] },
      }),
      expect.objectContaining({
        $set: {
          "extraction.cursorSeq": 2,
          "extraction.lastRunAt": repliedAt,
          "extraction.model": "google/gemini-3.6-flash",
        },
      }),
      { returnDocument: "after" },
    );

    await expect(
      repository.advanceCursor({ conversationId, toSeq: 3, at: repliedAt }),
    ).rejects.toBeInstanceOf(FeedbackConversationTransitionError);
  });

  it("advances goal statuses monotonically and never reopens an answer", async () => {
    const conversation = feedbackConversation({
      goals: [
        {
          key: "event_score",
          ordinal: 1,
          prompt: "score;",
          status: "answered",
        },
        { key: "liked", ordinal: 2, prompt: "liked;", status: "pending" },
        { key: "meet_again", ordinal: 3, prompt: "meet;", status: "pending" },
        { key: "avoid", ordinal: 4, prompt: "avoid;", status: "pending" },
      ],
    });
    const collection = collectionMock({
      findOne: vi.fn().mockResolvedValue(conversation),
      findOneAndUpdate: vi.fn().mockResolvedValue({
        ...conversation,
        goals: [
          conversation.goals[0],
          { ...conversation.goals[1], status: "asked" },
          conversation.goals[2],
          conversation.goals[3],
        ],
      }),
    });
    const repository = createRepository(collection);

    const result = await repository.updateGoalStatuses({
      conversationId,
      statuses: [
        // D16: an answered goal is not reopened, however confident a later run is.
        { key: "event_score", status: "asked" },
        { key: "liked", status: "asked" },
      ],
      at: repliedAt,
    });

    expect(result.changed).toBe(true);
    expect(collection.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ _id: conversationId }),
      expect.objectContaining({
        $set: { "goals.$[goal0].status": "asked" },
      }),
      {
        returnDocument: "after",
        arrayFilters: [
          { "goal0.key": "liked", "goal0.status": { $in: ["pending"] } },
        ],
      },
    );
  });

  it("upgrades a skipped goal to answered but not the reverse", async () => {
    const conversation = feedbackConversation({
      goals: [
        { key: "event_score", ordinal: 1, prompt: "score;", status: "skipped" },
        { key: "liked", ordinal: 2, prompt: "liked;", status: "answered" },
        { key: "meet_again", ordinal: 3, prompt: "meet;", status: "pending" },
        { key: "avoid", ordinal: 4, prompt: "avoid;", status: "pending" },
      ],
    });
    const collection = collectionMock({
      findOne: vi.fn().mockResolvedValue(conversation),
      findOneAndUpdate: vi.fn().mockResolvedValue(conversation),
    });
    const repository = createRepository(collection);

    await repository.updateGoalStatuses({
      conversationId,
      statuses: [
        { key: "event_score", status: "answered" },
        { key: "liked", status: "skipped" },
      ],
      at: repliedAt,
    });

    expect(collection.findOneAndUpdate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        $set: { "goals.$[goal0].status": "answered" },
      }),
      expect.objectContaining({
        arrayFilters: [
          {
            "goal0.key": "event_score",
            "goal0.status": { $in: ["pending", "asked", "skipped"] },
          },
        ],
      }),
    );
  });

  it("writes nothing when every proposed goal status is already reached", async () => {
    const collection = collectionMock({
      findOne: vi.fn().mockResolvedValue(
        feedbackConversation({
          goals: [
            {
              key: "event_score",
              ordinal: 1,
              prompt: "score;",
              status: "answered",
            },
            { key: "liked", ordinal: 2, prompt: "liked;", status: "pending" },
            {
              key: "meet_again",
              ordinal: 3,
              prompt: "meet;",
              status: "pending",
            },
            { key: "avoid", ordinal: 4, prompt: "avoid;", status: "pending" },
          ],
        }),
      ),
    });
    const repository = createRepository(collection);

    const result = await repository.updateGoalStatuses({
      conversationId,
      statuses: [{ key: "event_score", status: "answered" }],
      at: repliedAt,
    });

    expect(result.changed).toBe(false);
    expect(collection.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it("projects a compact campaign list without transcripts", async () => {
    const cursor = {
      toArray: vi.fn().mockResolvedValue([
        {
          _id: conversationId,
          campaignId,
          respondentParticipantId,
          phoneAtLaunch,
          lifecycle: { state: "open", reason: null },
          control: { mode: "bot", source: "launch" },
          goals: [{ key: "event_score", ordinal: 1, status: "asked" }],
          messageCount: 2,
          lastMessageAt: repliedAt,
          lastMessageActor: "participant",
          cursorSeq: 1,
          needsAttention: false,
          createdAt: launchedAt,
          updatedAt: repliedAt,
        },
      ]),
    };
    const collection = collectionMock({
      aggregate: vi.fn().mockReturnValue(cursor),
    });
    const repository = createRepository(collection);

    await expect(repository.listForCampaign(campaignId)).resolves.toEqual([
      expect.objectContaining({
        _id: conversationId,
        messageCount: 2,
        remindedAt: null,
      }),
    ]);

    const pipeline = collection.aggregate.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >[];
    const projection = pipeline.at(-1)?.["$project"] as Record<string, unknown>;
    expect(pipeline[0]).toEqual({
      $match: {
        schemaVersion: 2,
        purpose: "post_event_feedback",
        campaignId,
      },
    });
    expect(projection["messages"]).toBeUndefined();
    expect(projection["messageCount"]).toEqual({ $size: "$messages" });
  });

  it("reports a missing conversation instead of inventing one", async () => {
    const collection = collectionMock({
      findOne: vi.fn().mockResolvedValue(null),
    });
    const repository = createRepository(collection);

    await expect(
      repository.setNeedsAttention({
        conversationId,
        needsAttention: true,
        at: repliedAt,
      }),
    ).rejects.toBeInstanceOf(FeedbackConversationNotFoundError);
  });
});

function createRepository(
  collection: Partial<Collection<FeedbackConversationDocument>>,
): FeedbackConversationRepository {
  const mongo = {
    collection: vi.fn().mockResolvedValue(collection),
    ping: vi.fn().mockResolvedValue(undefined),
  } as unknown as MongoService;
  return new FeedbackConversationRepository(mongo);
}

function collectionMock(
  overrides: Partial<Collection<FeedbackConversationDocument>>,
): Collection<FeedbackConversationDocument> & {
  readonly aggregate: ReturnType<typeof vi.fn>;
  readonly createIndexes: ReturnType<typeof vi.fn>;
  readonly findOne: ReturnType<typeof vi.fn>;
  readonly findOneAndUpdate: ReturnType<typeof vi.fn>;
  readonly insertOne: ReturnType<typeof vi.fn>;
  readonly updateOne: ReturnType<typeof vi.fn>;
} {
  return {
    aggregate: vi.fn(),
    createIndexes: vi.fn().mockResolvedValue([]),
    findOne: vi.fn().mockResolvedValue(null),
    findOneAndUpdate: vi.fn().mockResolvedValue(null),
    insertOne: vi.fn().mockResolvedValue({ acknowledged: true }),
    updateOne: vi.fn().mockResolvedValue({ matchedCount: 1, modifiedCount: 1 }),
    ...overrides,
  } as unknown as Collection<FeedbackConversationDocument> & {
    readonly aggregate: ReturnType<typeof vi.fn>;
    readonly createIndexes: ReturnType<typeof vi.fn>;
    readonly findOne: ReturnType<typeof vi.fn>;
    readonly findOneAndUpdate: ReturnType<typeof vi.fn>;
    readonly insertOne: ReturnType<typeof vi.fn>;
    readonly updateOne: ReturnType<typeof vi.fn>;
  };
}

function duplicateKeyError(): MongoServerError {
  return new MongoServerError({ ok: 0, code: 11_000, errmsg: "duplicate key" });
}

function feedbackConversation(
  overrides: Partial<FeedbackConversationDocument>,
): FeedbackConversationDocument {
  return {
    _id: conversationId,
    schemaVersion: 2,
    purpose: "post_event_feedback",
    channel: "whatsapp",
    campaignId,
    respondentParticipantId,
    phoneAtLaunch,
    lifecycle: { state: "open", reason: null, closedAt: null },
    control: { mode: "bot", source: "launch", changedAt: launchedAt },
    goals: buildFeedbackConversationGoals(),
    messages: [],
    extraction: { cursorSeq: 0, lastRunAt: null, model: null },
    needsAttention: false,
    remindedAt: null,
    createdAt: launchedAt,
    updatedAt: repliedAt,
    ...overrides,
  };
}

function botMessage(seq: number): FeedbackConversationMessage {
  return {
    id: randomUUID(),
    seq,
    actor: "bot",
    text: "Πώς σου φάνηκε η βραδιά;",
    providerMessageId: null,
    ingressId: null,
    outboxId: seq === 1 ? outboxId : randomUUID(),
    at: launchedAt,
  };
}

function participantMessage(seq: number): FeedbackConversationMessage {
  return {
    id: randomUUID(),
    seq,
    actor: "participant",
    text: "Πέρασα τέλεια!",
    providerMessageId: null,
    ingressId: randomUUID(),
    outboxId: null,
    at: launchedAt,
  };
}
