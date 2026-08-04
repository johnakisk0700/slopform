import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import type { Collection } from "mongodb";
import { MongoServerError } from "mongodb";
import { describe, expect, it, vi } from "vitest";

import type { MongoService } from "../../infrastructure/mongo/mongo.service.js";
import { ConversationPersistenceError } from "../conversations/conversation-persistence.errors.js";
import {
  FeedbackConversationCapacityError,
  FeedbackConversationNotFoundError,
  FeedbackConversationPhoneConflictError,
  FeedbackConversationRepository,
  FeedbackConversationTransitionError,
} from "./post-event-feedback-conversation.repository.js";
import {
  FEEDBACK_CONVERSATION_MAX_MESSAGES,
  type FeedbackConversationDocument,
  type FeedbackConversationMessage,
  buildFeedbackConversationGoals,
  deriveFeedbackConversationId,
} from "./post-event-feedback-conversation.document.js";

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
const messageId = "5c7e6f10-3a2b-4c1d-8e9f-0a1b2c3d4e5f";
const reasonId = "7a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d";
const secondReasonId = "8b2c3d4e-5f6a-4b7c-9d8e-1f2a3b4c5d6e";

describe("FeedbackConversationRepository", () => {
  it("marks durable work due by atomically advancing its revision", async () => {
    const nextActionAt = new Date("2026-07-25T10:06:00.000Z");
    const updated = feedbackConversation({
      work: { revision: 4, nextActionAt, executionEpoch: 2 },
    });
    const collection = collectionMock({
      findOneAndUpdate: vi.fn().mockResolvedValue(updated),
    });
    const repository = createRepository(collection);

    await expect(
      repository.markWorkDue({
        conversationId,
        nextActionAt,
        at: repliedAt,
      }),
    ).resolves.toMatchObject({
      changed: true,
      work: { revision: 4, nextActionAt, executionEpoch: 2 },
    });
    expect(collection.findOneAndUpdate).toHaveBeenCalledWith(
      {
        _id: conversationId,
        schemaVersion: 2,
        purpose: "post_event_feedback",
      },
      [
        {
          $set: {
            "work.revision": {
              $add: [{ $ifNull: ["$work.revision", 0] }, 1],
            },
            "work.nextActionAt": nextActionAt,
            "work.executionEpoch": {
              $ifNull: ["$work.executionEpoch", 0],
            },
            updatedAt: { $max: ["$updatedAt", repliedAt] },
          },
        },
      ],
      { returnDocument: "after" },
    );
  });

  it("marks every open campaign conversation due without a list limit", async () => {
    const nextActionAt = new Date("2026-07-25T10:06:00.000Z");
    const updateMany = vi.fn().mockResolvedValue({ modifiedCount: 731 });
    const repository = createRepository(collectionMock({ updateMany }));

    await expect(
      repository.markCampaignWorkDue({
        campaignId,
        generation: 3,
        nextActionAt,
        at: repliedAt,
      }),
    ).resolves.toBe(731);
    expect(updateMany).toHaveBeenCalledWith(
      {
        schemaVersion: 2,
        purpose: "post_event_feedback",
        campaignId,
        "lifecycle.state": "open",
        $or: [
          { "work.campaignResumeGeneration": { $exists: false } },
          { "work.campaignResumeGeneration": { $lt: 3 } },
        ],
      },
      [
        {
          $set: {
            "work.revision": {
              $add: [{ $ifNull: ["$work.revision", 0] }, 1],
            },
            "work.nextActionAt": {
              $max: [
                { $ifNull: ["$work.nextActionAt", nextActionAt] },
                nextActionAt,
              ],
            },
            "work.executionEpoch": {
              $ifNull: ["$work.executionEpoch", 0],
            },
            "work.campaignResumeGeneration": 3,
            updatedAt: { $max: ["$updatedAt", repliedAt] },
          },
        },
      ],
    );
  });

  it("seeds one bounded legacy batch without overwriting concurrent work", async () => {
    const firstId = conversationId;
    const secondId = "7f0f2f8a-2b73-5a02-9d0a-3f0b8f5b1c22";
    const toArray = vi
      .fn()
      .mockResolvedValue([{ _id: firstId }, { _id: secondId }]);
    const limit = vi.fn().mockReturnValue({ toArray });
    const sort = vi.fn().mockReturnValue({ limit });
    const find = vi.fn().mockReturnValue({ sort });
    const updateMany = vi.fn().mockResolvedValue({ modifiedCount: 1 });
    const repository = createRepository(collectionMock({ find, updateMany }));

    await expect(
      repository.seedMissingWork({ dueAt: repliedAt, limit: 100 }),
    ).resolves.toBe(1);

    const missingWorkFilter = {
      schemaVersion: 2,
      purpose: "post_event_feedback",
      "lifecycle.state": "open",
      "control.mode": "bot",
      awaitingHuman: { $ne: true },
      work: { $exists: false },
    };
    expect(find).toHaveBeenCalledWith(missingWorkFilter, {
      projection: { _id: 1 },
    });
    expect(sort).toHaveBeenCalledWith({ _id: 1 });
    expect(limit).toHaveBeenCalledWith(100);
    expect(updateMany).toHaveBeenCalledWith(
      { ...missingWorkFilter, _id: { $in: [firstId, secondId] } },
      {
        $set: {
          work: {
            revision: 1,
            nextActionAt: repliedAt,
            executionEpoch: 0,
          },
        },
      },
    );
  });

  it("does not write when no legacy conversation needs a work seed", async () => {
    const toArray = vi.fn().mockResolvedValue([]);
    const limit = vi.fn().mockReturnValue({ toArray });
    const sort = vi.fn().mockReturnValue({ limit });
    const find = vi.fn().mockReturnValue({ sort });
    const updateMany = vi.fn();
    const repository = createRepository(collectionMock({ find, updateMany }));

    await expect(
      repository.seedMissingWork({ dueAt: repliedAt, limit: 100 }),
    ).resolves.toBe(0);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("repairs the bounded V1 cursor-first handoff crash without overriding staff resume", async () => {
    const secondId = "7f0f2f8a-2b73-5a02-9d0a-3f0b8f5b1c22";
    const toArray = vi
      .fn()
      .mockResolvedValue([{ _id: conversationId }, { _id: secondId }]);
    const limit = vi.fn().mockReturnValue({ toArray });
    const sort = vi.fn().mockReturnValue({ limit });
    const find = vi.fn().mockReturnValue({ sort });
    const updateMany = vi.fn().mockResolvedValue({ modifiedCount: 2 });
    const repository = createRepository(collectionMock({ find, updateMany }));

    await expect(
      repository.repairLegacyAwaitingHuman({ at: repliedAt, limit: 100 }),
    ).resolves.toBe(2);

    const [filter, options] = find.mock.calls[0] as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(filter).toMatchObject({
      schemaVersion: 2,
      purpose: "post_event_feedback",
      "lifecycle.state": "open",
      "control.mode": "bot",
      "control.source": { $ne: "staff_action" },
      awaitingHuman: { $ne: true },
    });
    expect(options).toEqual({ projection: { _id: 1 } });
    expect(sort).toHaveBeenCalledWith({ _id: 1 });
    expect(limit).toHaveBeenCalledWith(100);
    const serialized = JSON.stringify(filter);
    for (const evidence of [
      "handoff",
      "unfinished_questionnaire",
      "hostile_to_bot",
      "undelivered_message",
      "urgent_human_follow_up",
    ]) {
      expect(serialized).toContain(evidence);
    }
    expect(serialized).toContain("$extraction.cursorSeq");
    expect(serialized).toContain("$$message.seq");

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: { $in: [conversationId, secondId] },
        "control.source": { $ne: "staff_action" },
        awaitingHuman: { $ne: true },
      }),
      {
        $set: { awaitingHuman: true },
        $max: { updatedAt: repliedAt },
      },
    );
  });

  it("admits only a due exact revision under a strictly newer execution epoch", async () => {
    const dueAt = new Date("2026-07-25T10:04:00.000Z");
    const updated = feedbackConversation({
      work: { revision: 3, nextActionAt: dueAt, executionEpoch: 8 },
    });
    const collection = collectionMock({
      findOneAndUpdate: vi.fn().mockResolvedValue(updated),
    });
    const repository = createRepository(collection);

    const result = await repository.beginWorkExecution({
      conversationId,
      revision: 3,
      epoch: 8,
      at: repliedAt,
    });

    expect(result).toMatchObject({
      changed: true,
      work: { revision: 3, nextActionAt: dueAt, executionEpoch: 8 },
    });
    expect(collection.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        "work.nextActionAt": { $lte: repliedAt },
        $expr: {
          $and: [
            { $eq: [{ $ifNull: ["$work.revision", 0] }, 3] },
            { $lt: [{ $ifNull: ["$work.executionEpoch", 0] }, 8] },
          ],
        },
      }),
      [
        {
          $set: {
            "work.revision": 3,
            "work.executionEpoch": 8,
          },
        },
      ],
      { returnDocument: "after" },
    );
  });

  it("does not admit an execution after a message advanced the revision", async () => {
    const newerDue = new Date("2026-07-25T10:06:30.000Z");
    const current = feedbackConversation({
      work: { revision: 4, nextActionAt: newerDue, executionEpoch: 7 },
    });
    const collection = collectionMock({
      findOneAndUpdate: vi.fn().mockResolvedValue(null),
      findOne: vi.fn().mockResolvedValue(current),
    });
    const repository = createRepository(collection);

    await expect(
      repository.beginWorkExecution({
        conversationId,
        revision: 3,
        epoch: 8,
        at: repliedAt,
      }),
    ).resolves.toMatchObject({
      changed: false,
      work: { revision: 4, nextActionAt: newerDue, executionEpoch: 7 },
    });
  });

  it("settles its snapshot without erasing a newer revision's rolling schedule", async () => {
    const newerDue = new Date("2026-07-25T10:07:00.000Z");
    const current = feedbackConversation({
      work: { revision: 6, nextActionAt: newerDue, executionEpoch: 11 },
    });
    const collection = collectionMock({
      findOneAndUpdate: vi.fn().mockResolvedValue(current),
    });
    const repository = createRepository(collection);

    await expect(
      repository.settleWorkExecution({
        conversationId,
        revision: 5,
        epoch: 11,
        nextActionAt: null,
        at: repliedAt,
      }),
    ).resolves.toMatchObject({
      changed: true,
      work: { revision: 6, nextActionAt: newerDue, executionEpoch: 11 },
    });
    expect(collection.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        "work.executionEpoch": 11,
        "work.revision": { $gte: 5 },
      }),
      [
        {
          $set: {
            "work.revision": {
              $cond: [
                {
                  $and: [{ $eq: ["$work.revision", 5] }, { $ne: [null, null] }],
                },
                { $add: ["$work.revision", 1] },
                "$work.revision",
              ],
            },
            "work.nextActionAt": {
              $cond: [
                { $eq: ["$work.revision", 5] },
                null,
                "$work.nextActionAt",
              ],
            },
          },
        },
      ],
      { returnDocument: "after" },
    );
  });

  it("advances the revision when settlement schedules a successor wake-up", async () => {
    const nextActionAt = new Date("2026-07-25T10:07:00.000Z");
    const rescheduled = feedbackConversation({
      work: { revision: 6, nextActionAt, executionEpoch: 11 },
    });
    const collection = collectionMock({
      findOneAndUpdate: vi.fn().mockResolvedValue(rescheduled),
    });
    const repository = createRepository(collection);

    await expect(
      repository.settleWorkExecution({
        conversationId,
        revision: 5,
        epoch: 11,
        nextActionAt,
        at: repliedAt,
      }),
    ).resolves.toMatchObject({
      changed: true,
      work: { revision: 6, nextActionAt, executionEpoch: 11 },
    });
    const [, update] = collection.findOneAndUpdate.mock.calls[0] as [
      unknown,
      [{ $set: Record<string, unknown> }],
    ];
    expect(update[0].$set["work.revision"]).toEqual({
      $cond: [
        {
          $and: [{ $eq: ["$work.revision", 5] }, { $ne: [nextActionAt, null] }],
        },
        { $add: ["$work.revision", 1] },
        "$work.revision",
      ],
    });
  });

  it("lists due work oldest-first, including terminal rows that need a cheap settlement", async () => {
    const dueAt = new Date("2026-07-25T11:00:00.000Z");
    const closed = feedbackConversation({
      lifecycle: { state: "closed", reason: "completed", closedAt: repliedAt },
      work: { revision: 2, nextActionAt: repliedAt, executionEpoch: 1 },
    });
    const toArray = vi.fn().mockResolvedValue([closed]);
    const limit = vi.fn().mockReturnValue({ toArray });
    const sort = vi.fn().mockReturnValue({ limit });
    const find = vi.fn().mockReturnValue({ sort });
    const repository = createRepository(collectionMock({ find }));

    await expect(repository.listDueWork({ dueAt, limit: 25 })).resolves.toEqual(
      [closed],
    );
    expect(find).toHaveBeenCalledWith({
      schemaVersion: 2,
      purpose: "post_event_feedback",
      "work.nextActionAt": { $lte: dueAt },
    });
    expect(sort).toHaveBeenCalledWith({ "work.nextActionAt": 1, _id: 1 });
    expect(limit).toHaveBeenCalledWith(25);
  });

  it("continues a due-work scan after the exact date and conversation key", async () => {
    const dueAt = new Date("2026-07-25T11:00:00.000Z");
    const cursor = {
      nextActionAt: repliedAt,
      conversationId: "0f0f2f8a-2b73-5a02-9d0a-3f0b8f5b1c20",
    };
    const toArray = vi.fn().mockResolvedValue([]);
    const limit = vi.fn().mockReturnValue({ toArray });
    const sort = vi.fn().mockReturnValue({ limit });
    const find = vi.fn().mockReturnValue({ sort });
    const repository = createRepository(collectionMock({ find }));

    await expect(
      repository.listDueWork({
        dueAt,
        limit: 100,
        campaignId,
        after: cursor,
      }),
    ).resolves.toEqual([]);

    expect(find).toHaveBeenCalledWith({
      schemaVersion: 2,
      purpose: "post_event_feedback",
      campaignId,
      $or: [
        {
          "work.nextActionAt": {
            $gt: cursor.nextActionAt,
            $lte: dueAt,
          },
        },
        {
          "work.nextActionAt": cursor.nextActionAt,
          _id: { $gt: cursor.conversationId },
        },
      ],
    });
    expect(sort).toHaveBeenCalledWith({ "work.nextActionAt": 1, _id: 1 });
    expect(limit).toHaveBeenCalledWith(100);
  });

  it("projects durable extraction accounting for a campaign set in one read", async () => {
    const usage = {
      inputTokens: 1_200,
      outputTokens: 200,
      totalTokens: 1_400,
    };
    const toArray = vi.fn().mockResolvedValue([
      feedbackConversation({
        extraction: {
          cursorSeq: 1,
          lastRunAt: repliedAt,
          model: "openai/gpt-5.6-terra",
          usage,
          serviceTier: "priority",
          parkedSince: null,
          parkedRuns: 0,
          parkedNoticeSentAt: null,
        },
      }),
    ]);
    const find = vi.fn().mockReturnValue({ toArray });
    const collection = collectionMock({ find });
    const repository = createRepository(collection);

    await expect(
      repository.listExtractionAccountingForCampaigns([campaignId, campaignId]),
    ).resolves.toEqual([
      {
        conversationId,
        extraction: {
          model: "openai/gpt-5.6-terra",
          usage,
          serviceTier: "priority",
        },
      },
    ]);
    expect(find).toHaveBeenCalledWith(
      {
        schemaVersion: 2,
        purpose: "post_event_feedback",
        campaignId: { $in: [campaignId] },
      },
      {
        projection: {
          _id: 1,
          "extraction.model": 1,
          "extraction.usage": 1,
          "extraction.serviceTier": 1,
        },
      },
    );
  });

  it("does not open MongoDB for empty extraction accounting scope", async () => {
    const collection = collectionMock({});
    const mongo = {
      collection: vi.fn().mockResolvedValue(collection),
      ping: vi.fn().mockResolvedValue(undefined),
    } as unknown as MongoService;
    const repository = new FeedbackConversationRepository(mongo);

    await expect(
      repository.listExtractionAccountingForCampaigns([]),
    ).resolves.toEqual([]);
    expect(mongo.collection).not.toHaveBeenCalled();
  });

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
        extraction: {
          cursorSeq: 0,
          lastRunAt: null,
          model: null,
          // A launched conversation has bought nothing yet, and the defaults
          // say so rather than leaving the fields off the document.
          usage: null,
          serviceTier: null,
          parkedSince: null,
          parkedRuns: 0,
          parkedNoticeSentAt: null,
        },
        work: { revision: 0, nextActionAt: null, executionEpoch: 0 },
        needsAttention: false,
        attentionReasons: [],
      }),
    });
    expect(result.conversation.goals.map((goal) => goal.key)).toEqual([
      "event_score",
      "table_fit",
      "participation_ease",
      "conversation_balance",
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
      {
        name: "feedback_conversation_work_due_idx",
        key: { "work.nextActionAt": 1, _id: 1 },
        partialFilterExpression: {
          purpose: "post_event_feedback",
          "work.nextActionAt": { $type: "date" },
        },
      },
    ]);
  });

  it("keeps the due-work index name aligned with fresh-volume provisioning", () => {
    const mongoInit = readFileSync(
      new URL(
        "../../../../../docker/mongo-init/10-app-user.js",
        import.meta.url,
      ),
      "utf8",
    );

    expect(mongoInit).toContain('name: "feedback_conversation_work_due_idx"');
    expect(mongoInit).not.toContain(
      'name: "feedback_conversation_due_work_idx"',
    );
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

  it("authorizes only the terminal outbox id paired to its own conversation", async () => {
    const otherConversationId = "f0562a6b-d334-43f0-a029-43298a559ac0";
    const otherOutboxId = "14b0d0f3-8cf0-4420-ae96-8eb77a21915e";
    const find = vi.fn().mockReturnValue({
      toArray: vi.fn().mockResolvedValue([
        {
          _id: conversationId,
          lifecycle: {
            state: "closed",
            terminalOutboxId: outboxId,
          },
        },
      ]),
    });
    const collection = collectionMock({ find } as never);
    const repository = createRepository(collection);

    await expect(
      repository.listCurrentTerminalOutboxIds([
        { conversationId, outboxId },
        // The id exists in the batch but belongs to no returned lifecycle.
        { conversationId: otherConversationId, outboxId: otherOutboxId },
        // Cross-pairing the first lifecycle with the other row stays invalid.
        { conversationId, outboxId: otherOutboxId },
      ]),
    ).resolves.toEqual([outboxId]);

    expect(find).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: { $in: [conversationId, otherConversationId] },
        "lifecycle.state": "closed",
        "lifecycle.terminalOutboxId": {
          $in: [outboxId, otherOutboxId],
        },
      }),
      {
        projection: {
          _id: 1,
          "lifecycle.state": 1,
          "lifecycle.terminalOutboxId": 1,
        },
      },
    );
  });

  it("projects exact STOP terminal ids for campaign-close preservation", async () => {
    const find = vi.fn().mockReturnValue({
      toArray: vi.fn().mockResolvedValue([
        {
          lifecycle: {
            state: "closed",
            reason: "stopped",
            terminalOutboxId: outboxId,
          },
        },
      ]),
    });
    const repository = createRepository(collectionMock({ find } as never));

    await expect(
      repository.listStopTerminalOutboxIdsForCampaign(campaignId),
    ).resolves.toEqual([outboxId]);
    expect(find).toHaveBeenCalledWith(
      expect.objectContaining({
        campaignId,
        "lifecycle.state": "closed",
        "lifecycle.reason": "stopped",
      }),
      expect.objectContaining({
        projection: expect.objectContaining({
          "lifecycle.terminalOutboxId": 1,
        }),
      }),
    );
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
        // Sorted on write by observation time: webhooks can arrive backwards
        // and a transcript read in arrival order rewrites a split thought.
        $push: {
          messages: { $each: [result.message], $sort: { at: 1, seq: 1 } },
        },
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

  it("merges attention metadata onto the cited participant message", async () => {
    const message = participantMessage(1);
    const current = feedbackConversation({ messages: [message] });
    const attention = {
      categories: ["sexual_misconduct"] as const,
      recommendedAction: "human_follow_up" as const,
      confidence: 0.94,
    };
    const collection = collectionMock({
      findOne: vi.fn().mockResolvedValue(current),
      findOneAndUpdate: vi.fn().mockResolvedValue({
        ...current,
        messages: [{ ...message, attention }],
      }),
    });
    const repository = createRepository(collection);

    const result = await repository.mergeMessageAttention({
      conversationId,
      messageId: message.id,
      categories: ["sexual_misconduct"],
      recommendedAction: "human_follow_up",
      confidence: 0.94,
      at: repliedAt,
    });

    expect(result.changed).toBe(true);
    expect(result.conversation.messages[0]?.attention).toEqual(attention);
    expect(collection.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: {
          $elemMatch: { id: message.id, attention: null },
        },
      }),
      {
        $set: { "messages.$[message].attention": attention },
        $max: { updatedAt: repliedAt },
      },
      {
        returnDocument: "after",
        arrayFilters: [{ "message.id": message.id }],
      },
    );
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

  it("names the raise instead of dropping a message at the transcript cap", async () => {
    const messages = Array.from(
      { length: FEEDBACK_CONVERSATION_MAX_MESSAGES },
      (_, index) => participantMessage(index + 1),
    );
    const full = feedbackConversation({ messages });
    const collection = collectionMock({
      findOne: vi.fn().mockResolvedValue(full),
      findOneAndUpdate: vi.fn().mockResolvedValue({
        ...full,
        needsAttention: true,
        attentionReasons: [
          attentionReason({ kind: "transcript_full", messageId: null }),
        ],
      }),
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
    // The one raise no caller can name for itself, because only the repository
    // knows the document is full. Anchored on nothing: the message that would
    // have explained it is the one there was no room for.
    const [, update] = collection.findOneAndUpdate.mock.calls[0] as [
      Record<string, unknown>,
      Record<string, Record<string, unknown>>,
    ];
    expect(update["$set"]).toEqual({ needsAttention: true });
    expect(update["$push"]?.["attentionReasons"]).toMatchObject({
      kind: "transcript_full",
      messageId: null,
      resolvedAt: null,
    });
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
        "lifecycle.state": "open",
      }),
      {
        $set: {
          control: {
            mode: "human",
            source: "external_outbound",
            changedAt: repliedAt,
          },
          // A person has arrived, so any bot-side wait for one is over.
          awaitingHuman: false,
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

  it("atomically clears due work without advancing its revision when awaiting human", async () => {
    const awaiting = feedbackConversation({
      awaitingHuman: true,
      work: {
        revision: 7,
        nextActionAt: null,
        executionEpoch: 3,
        campaignResumeGeneration: 2,
      },
    });
    const findOneAndUpdate = vi.fn().mockResolvedValue(awaiting);
    const repository = createRepository(collectionMock({ findOneAndUpdate }));

    await expect(
      repository.markAwaitingHuman({ conversationId, at: repliedAt }),
    ).resolves.toMatchObject({
      changed: true,
      conversation: {
        awaitingHuman: true,
        work: {
          revision: 7,
          nextActionAt: null,
          executionEpoch: 3,
          campaignResumeGeneration: 2,
        },
      },
    });

    expect(findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: conversationId,
        "lifecycle.state": "open",
        "control.mode": "bot",
        $or: [
          { awaitingHuman: { $ne: true } },
          { "work.nextActionAt": { $type: "date" } },
        ],
      }),
      [
        {
          $set: {
            awaitingHuman: true,
            work: {
              $cond: [
                { $eq: [{ $type: "$work" }, "missing"] },
                "$$REMOVE",
                { $mergeObjects: ["$work", { nextActionAt: null }] },
              ],
            },
            updatedAt: { $max: ["$updatedAt", repliedAt] },
          },
        },
      ],
      { returnDocument: "after" },
    );
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

  it("resumes control and creates unread work in one generation-fenced update", async () => {
    const resumed = feedbackConversation({
      control: { mode: "bot", source: "staff_action", changedAt: repliedAt },
      messages: [botMessage(1), participantMessage(2)],
      extraction: {
        cursorSeq: 1,
        lastRunAt: null,
        model: null,
        usage: null,
        serviceTier: null,
        parkedSince: null,
        parkedRuns: 0,
        parkedNoticeSentAt: null,
      },
      work: { revision: 8, nextActionAt: repliedAt, executionEpoch: 4 },
    });
    const findOneAndUpdate = vi.fn().mockResolvedValue(resumed);
    const repository = createRepository(collectionMock({ findOneAndUpdate }));

    await expect(
      repository.resumeBot({ conversationId, at: repliedAt }),
    ).resolves.toMatchObject({
      changed: true,
      conversation: {
        control: { mode: "bot", source: "staff_action" },
        work: { revision: 8, nextActionAt: repliedAt, executionEpoch: 4 },
      },
    });

    expect(findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: conversationId,
        "control.mode": "human",
        "lifecycle.state": "open",
      }),
      expect.any(Array),
      { returnDocument: "after" },
    );
    const update = findOneAndUpdate.mock.calls[0]?.[1] as Array<{
      $set: Record<string, unknown>;
    }>;
    expect(update[0]?.$set).toMatchObject({
      control: { mode: "bot", source: "staff_action", changedAt: repliedAt },
      awaitingHuman: false,
      "work.revision": {
        $add: [{ $ifNull: ["$work.revision", 0] }, 1],
      },
      "work.executionEpoch": { $ifNull: ["$work.executionEpoch", 0] },
      updatedAt: { $max: ["$updatedAt", repliedAt] },
    });
    expect(update[0]?.$set["work.nextActionAt"]).toEqual({
      $cond: [
        expect.objectContaining({ $gt: expect.any(Array) }),
        repliedAt,
        { $ifNull: ["$work.nextActionAt", null] },
      ],
    });
    expect(JSON.stringify(update[0]?.$set["work.nextActionAt"])).toContain(
      "participant",
    );
  });

  it("lets STOP override a softer terminal reason but never the reverse", async () => {
    const stopped = feedbackConversation({
      lifecycle: {
        state: "closed",
        reason: "stopped",
        closedAt: repliedAt,
        terminalOutboxId: outboxId,
      },
    });
    const collection = collectionMock({
      findOneAndUpdate: vi.fn().mockResolvedValue(stopped),
    });
    const repository = createRepository(collection);

    await expect(
      repository.close({
        conversationId,
        reason: "stopped",
        at: repliedAt,
        terminalOutboxId: outboxId,
      }),
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
            terminalOutboxId: outboxId,
          },
          // STOP clears any earlier staff close reason so "abusive" cannot
          // survive a consent withdrawal that superseded it.
          staffClose: null,
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

  it("lowers the badge on close when no reason is holding it up", async () => {
    // The bug: the inbox buckets on attention before lifecycle, so a flagged
    // conversation that was then closed pinned itself above every open one for
    // good — and closing it, the operator's one «I am done with this», did
    // nothing about the flag. A bare flag has no reason to dismiss instead.
    const flagged = feedbackConversation({ needsAttention: true });
    const closed = feedbackConversation({
      needsAttention: true,
      lifecycle: { state: "closed", reason: "cancelled", closedAt: repliedAt },
    });
    const collection = collectionMock({
      findOneAndUpdate: vi
        .fn()
        .mockResolvedValueOnce(closed)
        .mockResolvedValueOnce({ ...closed, needsAttention: false }),
      findOne: vi.fn().mockResolvedValue(flagged),
    });
    const repository = createRepository(collection);

    const result = await repository.close({
      conversationId,
      reason: "cancelled",
      at: repliedAt,
    });

    expect(result.changed).toBe(true);
    expect(result.conversation.needsAttention).toBe(false);
    // Guarded on the list still being clean, so a reason raised between the two
    // writes keeps its badge.
    const [filter, update] = collection.findOneAndUpdate.mock.calls[1] as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(filter["needsAttention"]).toBe(true);
    expect(filter["attentionReasons"]).toEqual({
      $not: { $elemMatch: { resolvedAt: null } },
    });
    expect(update["$set"]).toEqual({ needsAttention: false });
  });

  it("lowers the badge on close once every reason has been dismissed", async () => {
    const closed = feedbackConversation({
      needsAttention: true,
      lifecycle: { state: "closed", reason: "completed", closedAt: repliedAt },
      attentionReasons: [
        attentionReason({ kind: "safety", resolvedAt: repliedAt }),
      ],
    });
    const collection = collectionMock({
      findOneAndUpdate: vi
        .fn()
        .mockResolvedValueOnce(closed)
        .mockResolvedValueOnce({ ...closed, needsAttention: false }),
    });
    const repository = createRepository(collection);

    const result = await repository.close({
      conversationId,
      reason: "completed",
      at: repliedAt,
    });

    expect(result.conversation.needsAttention).toBe(false);
    expect(collection.findOneAndUpdate).toHaveBeenCalledTimes(2);
  });

  it("never auto-resolves a standing reason just because the thread closed", async () => {
    const closed = feedbackConversation({
      needsAttention: true,
      lifecycle: { state: "closed", reason: "cancelled", closedAt: repliedAt },
      attentionReasons: [attentionReason({ kind: "handoff" })],
    });
    const collection = collectionMock({
      findOneAndUpdate: vi.fn().mockResolvedValue(closed),
    });
    const repository = createRepository(collection);

    const result = await repository.close({
      conversationId,
      reason: "cancelled",
      at: repliedAt,
    });

    // «σβήστε ό,τι σας είπα» does not stop being a request because the
    // questionnaire ended, and resolving it here would file it as handled by
    // nobody, under a `resolvedBy` we would have had to invent. One write only:
    // the close itself.
    expect(result.conversation.needsAttention).toBe(true);
    expect(result.conversation.attentionReasons[0]?.resolvedAt).toBeNull();
    expect(collection.findOneAndUpdate).toHaveBeenCalledTimes(1);
  });

  it("advances the extraction cursor only forward and only inside the transcript", async () => {
    const conversation = feedbackConversation({
      messages: [botMessage(1), participantMessage(2)],
      extraction: {
        cursorSeq: 2,
        lastRunAt: repliedAt,
        model: null,
        usage: null,
        serviceTier: null,
        parkedSince: null,
        parkedRuns: 0,
        parkedNoticeSentAt: null,
      },
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
      [
        {
          $set: expect.objectContaining({
            "extraction.cursorSeq": 2,
            "extraction.lastRunAt": repliedAt,
            "extraction.model": "google/gemini-3.6-flash",
            "extraction.serviceTier": null,
            // A run that moved the cursor reached the provider, so the same
            // write ends any park. The notice ledger is deliberately absent
            // from the set: it records that a person was already apologised to
            // once.
            "extraction.parkedSince": null,
            "extraction.parkedRuns": 0,
          }),
        },
      ],
      { returnDocument: "after" },
    );
    // A run that passed no usage must not touch the accumulator at all — a
    // literal null here is what would have wiped the totals of every earlier run.
    const [, update] = collection.findOneAndUpdate.mock.calls[0] as [
      unknown,
      [{ $set: Record<string, unknown> }],
    ];
    expect(update[0].$set).not.toHaveProperty("extraction.usage");

    await expect(
      repository.advanceCursor({ conversationId, toSeq: 3, at: repliedAt }),
    ).rejects.toBeInstanceOf(FeedbackConversationTransitionError);
  });

  it("adds a reported component to whatever is already stored", async () => {
    const advanced = feedbackConversation({
      messages: [botMessage(1), participantMessage(2)],
      extraction: {
        cursorSeq: 2,
        lastRunAt: repliedAt,
        model: "google/gemini-3.6-flash",
        usage: { inputTokens: 1_200, outputTokens: 200, totalTokens: 1_400 },
        serviceTier: null,
        parkedSince: null,
        parkedRuns: 0,
        parkedNoticeSentAt: null,
      },
    });
    const collection = collectionMock({
      findOneAndUpdate: vi.fn().mockResolvedValue(advanced),
    });
    const repository = createRepository(collection);

    await repository.advanceCursor({
      conversationId,
      toSeq: 2,
      at: repliedAt,
      model: "google/gemini-3.6-flash",
      usage: { inputTokens: 300, outputTokens: 80, totalTokens: 380 },
    });

    // The increment is a pipeline expression rather than a literal, because a
    // read-then-write would let two runs of the same conversation each add to a
    // total the other had not written yet.
    const [, update] = collection.findOneAndUpdate.mock.calls[0] as [
      unknown,
      [{ $set: Record<string, unknown> }],
    ];
    expect(update[0].$set["extraction.usage"]).toEqual({
      inputTokens: usageIncrement("inputTokens", 300),
      outputTokens: usageIncrement("outputTokens", 80),
      totalTokens: usageIncrement("totalTokens", 380),
    });
  });

  it("fences an ordinary paid cursor advance by the exact Mongo work generation", async () => {
    const advanced = feedbackConversation({
      messages: [botMessage(1), participantMessage(2)],
      work: { revision: 7, nextActionAt: repliedAt, executionEpoch: 3 },
      extraction: {
        cursorSeq: 2,
        lastRunAt: repliedAt,
        model: "google/gemini-3.6-flash",
        usage: { inputTokens: 300, outputTokens: 80, totalTokens: 380 },
        serviceTier: null,
        parkedSince: null,
        parkedRuns: 0,
        parkedNoticeSentAt: null,
      },
    });
    const collection = collectionMock({
      findOneAndUpdate: vi.fn().mockResolvedValue(advanced),
    });
    const repository = createRepository(collection);

    await repository.advanceCursor({
      conversationId,
      toSeq: 2,
      at: repliedAt,
      model: "google/gemini-3.6-flash",
      usage: { inputTokens: 300, outputTokens: 80, totalTokens: 380 },
      workRevision: 7,
      executionEpoch: 3,
    });

    expect(collection.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        "extraction.cursorSeq": { $lt: 2 },
        "work.revision": 7,
        "work.executionEpoch": 3,
      }),
      expect.anything(),
      { returnDocument: "after" },
    );
  });

  it("atomically advances awaiting-human rows left with a stale cursor", async () => {
    const awaiting = feedbackConversation({
      messages: [botMessage(1), participantMessage(2)],
      awaitingHuman: true,
      extraction: {
        cursorSeq: 2,
        lastRunAt: repliedAt,
        model: "google/gemini-3.6-flash",
        usage: { inputTokens: 300, outputTokens: 80, totalTokens: 380 },
        serviceTier: null,
        parkedSince: null,
        parkedRuns: 0,
        parkedNoticeSentAt: null,
      },
    });
    const collection = collectionMock({
      findOneAndUpdate: vi.fn().mockResolvedValue(awaiting),
    });
    const repository = createRepository(collection);

    await expect(
      repository.advanceCursorAndMarkAwaitingHuman({
        conversationId,
        toSeq: 2,
        at: repliedAt,
        model: "google/gemini-3.6-flash",
        serviceTier: null,
        usage: { inputTokens: 300, outputTokens: 80, totalTokens: 380 },
        workRevision: 3,
        executionEpoch: 4,
      }),
    ).resolves.toEqual(expect.objectContaining({ changed: true }));

    expect(collection.findOneAndUpdate).toHaveBeenCalledTimes(1);
    const [filter, update, options] = collection.findOneAndUpdate.mock
      .calls[0] as [
      Record<string, unknown>,
      [{ $set: Record<string, unknown> }],
      Record<string, unknown>,
    ];
    expect(filter).toMatchObject({
      _id: conversationId,
      "lifecycle.state": "open",
      "control.mode": "bot",
    });
    expect(filter).not.toHaveProperty("extraction.cursorSeq");
    expect(JSON.stringify(filter.$expr)).toContain("work.revision");
    expect(JSON.stringify(filter.$expr)).toContain("participant");
    expect(update[0].$set).toMatchObject({
      "extraction.cursorSeq": {
        $max: ["$extraction.cursorSeq", 2],
      },
      "extraction.usage": {
        $cond: [
          { $lt: ["$extraction.cursorSeq", 2] },
          {
            inputTokens: usageIncrement("inputTokens", 300),
            outputTokens: usageIncrement("outputTokens", 80),
            totalTokens: usageIncrement("totalTokens", 380),
          },
          "$extraction.usage",
        ],
      },
      awaitingHuman: true,
    });
    expect(options).toEqual({ returnDocument: "after" });
    // Replays may already have raised the brake; it must not exclude the
    // accounting/cursor repair from the same atomic statement.
    expect(filter).not.toHaveProperty("awaitingHuman");
  });

  it("admits a newer work revision only when the same execution has newer testimony", async () => {
    const updated = feedbackConversation({
      messages: [botMessage(1), participantMessage(2), participantMessage(3)],
      awaitingHuman: true,
      work: { revision: 4, nextActionAt: repliedAt, executionEpoch: 7 },
      extraction: {
        cursorSeq: 2,
        lastRunAt: repliedAt,
        model: "google/gemini-3.6-flash",
        usage: { inputTokens: 300, outputTokens: 80, totalTokens: 380 },
        serviceTier: null,
        parkedSince: null,
        parkedRuns: 0,
        parkedNoticeSentAt: null,
      },
    });
    const findOneAndUpdate = vi.fn().mockResolvedValue(updated);
    const repository = createRepository(collectionMock({ findOneAndUpdate }));

    await repository.advanceCursorAndMarkAwaitingHuman({
      conversationId,
      toSeq: 2,
      at: repliedAt,
      model: "google/gemini-3.6-flash",
      serviceTier: null,
      usage: { inputTokens: 300, outputTokens: 80, totalTokens: 380 },
      workRevision: 3,
      executionEpoch: 7,
    });

    const filter = findOneAndUpdate.mock.calls[0]?.[0] as {
      $expr: unknown;
    };
    const admission = JSON.stringify(filter.$expr);
    expect(admission).toContain('"$gt":[{"$ifNull":["$work.revision",0]},3]');
    expect(admission).toContain(
      '"$eq":[{"$ifNull":["$work.executionEpoch",0]},7]',
    );
    expect(admission).toContain('"$$message.actor","participant"');
    expect(admission).toContain('"$$message.seq",2');
  });

  it("advances the snapshot cursor and closes only when no newer participant message exists", async () => {
    const closed = feedbackConversation({
      messages: [botMessage(1), participantMessage(2)],
      lifecycle: {
        state: "closed",
        reason: "completed",
        closedAt: repliedAt,
        terminalOutboxId: outboxId,
      },
      extraction: {
        cursorSeq: 2,
        lastRunAt: repliedAt,
        model: "google/gemini-3.6-flash",
        usage: { inputTokens: 300, outputTokens: 80, totalTokens: 380 },
        serviceTier: null,
        parkedSince: null,
        parkedRuns: 0,
        parkedNoticeSentAt: null,
      },
    });
    const collection = collectionMock({
      findOneAndUpdate: vi.fn().mockResolvedValue(closed),
    });
    const repository = createRepository(collection);

    await expect(
      repository.advanceCursorAndClose({
        conversationId,
        toSeq: 2,
        reason: "completed",
        terminalOutboxId: outboxId,
        at: repliedAt,
        model: "google/gemini-3.6-flash",
        serviceTier: null,
        usage: { inputTokens: 300, outputTokens: 80, totalTokens: 380 },
        workRevision: 3,
        executionEpoch: 4,
      }),
    ).resolves.toEqual(expect.objectContaining({ changed: true }));

    expect(collection.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: conversationId,
        "lifecycle.state": "open",
        "control.mode": "bot",
        awaitingHuman: { $ne: true },
        "work.revision": 3,
        "work.executionEpoch": 4,
        $expr: {
          $and: [
            { $lte: [2, { $size: "$messages" }] },
            {
              $eq: [
                {
                  $size: {
                    $filter: {
                      input: "$messages",
                      as: "message",
                      cond: {
                        $and: [
                          { $eq: ["$$message.actor", "participant"] },
                          { $gt: ["$$message.seq", 2] },
                        ],
                      },
                    },
                  },
                },
                0,
              ],
            },
          ],
        },
      }),
      [
        {
          $set: expect.objectContaining({
            "extraction.cursorSeq": {
              $max: ["$extraction.cursorSeq", 2],
            },
            lifecycle: {
              state: "closed",
              reason: "completed",
              closedAt: repliedAt,
              terminalOutboxId: outboxId,
            },
          }),
        },
      ],
      { returnDocument: "after" },
    );
  });

  it("leaves the conversation open when the terminal snapshot was superseded", async () => {
    const current = feedbackConversation({
      messages: [botMessage(1), participantMessage(2), participantMessage(3)],
    });
    const collection = collectionMock({
      findOneAndUpdate: vi.fn().mockResolvedValue(null),
      findOne: vi.fn().mockResolvedValue(current),
    });
    const repository = createRepository(collection);

    await expect(
      repository.advanceCursorAndClose({
        conversationId,
        toSeq: 2,
        reason: "completed",
        terminalOutboxId: outboxId,
        at: repliedAt,
        model: "google/gemini-3.6-flash",
        serviceTier: null,
        usage: { inputTokens: 300, outputTokens: 80, totalTokens: 380 },
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        changed: false,
        conversation: expect.objectContaining({
          lifecycle: expect.objectContaining({ state: "open" }),
        }),
      }),
    );
  });

  it("writes an unreported component as a literal null the sums can never leave", async () => {
    const collection = collectionMock({
      findOneAndUpdate: vi.fn().mockResolvedValue(null),
      findOne: vi.fn().mockResolvedValue(
        feedbackConversation({
          messages: [botMessage(1), participantMessage(2)],
        }),
      ),
    });
    const repository = createRepository(collection);

    await repository.advanceCursor({
      conversationId,
      toSeq: 2,
      at: repliedAt,
      model: "google/gemini-3.6-flash",
      usage: { inputTokens: 300, outputTokens: null, totalTokens: null },
    });

    const [, update] = collection.findOneAndUpdate.mock.calls[0] as [
      unknown,
      [{ $set: Record<string, unknown> }],
    ];
    // Input still accumulates. The two the provider stayed silent about are set
    // to null outright — nothing to compute, and nothing a later run undoes.
    expect(update[0].$set["extraction.usage"]).toEqual({
      inputTokens: usageIncrement("inputTokens", 300),
      outputTokens: null,
      totalTokens: null,
    });
  });

  it("overwrites the service tier on every run, including back to none", async () => {
    const collection = collectionMock({
      findOneAndUpdate: vi.fn().mockResolvedValue(null),
      findOne: vi.fn().mockResolvedValue(
        feedbackConversation({
          messages: [botMessage(1), participantMessage(2)],
        }),
      ),
    });
    const repository = createRepository(collection);

    await repository.advanceCursor({
      conversationId,
      toSeq: 2,
      at: repliedAt,
      serviceTier: "priority",
    });
    // The fast lane was turned off between runs. The tier is a property of the
    // call that just happened, not a ledger, so it goes back to null rather
    // than leaving the conversation costed at OpenAI's priority rates forever.
    await repository.advanceCursor({
      conversationId,
      toSeq: 2,
      at: repliedAt,
      serviceTier: null,
    });

    const tiers = collection.findOneAndUpdate.mock.calls.map(
      (call) =>
        (call as [unknown, [{ $set: Record<string, unknown> }]])[1][0].$set[
          "extraction.serviceTier"
        ],
    );
    expect(tiers).toEqual(["priority", null]);
  });

  it("keeps the first park's start time while counting every parked run", async () => {
    const parked = feedbackConversation({
      extraction: {
        cursorSeq: 0,
        lastRunAt: null,
        model: null,
        usage: null,
        serviceTier: null,
        parkedSince: repliedAt,
        parkedRuns: 4,
        parkedNoticeSentAt: null,
      },
    });
    const collection = collectionMock({
      findOneAndUpdate: vi.fn().mockResolvedValue(parked),
    });
    const repository = createRepository(collection);

    await expect(
      repository.parkExtraction({ conversationId, at: repliedAt }),
    ).resolves.toEqual(expect.objectContaining({ changed: true }));
    // One atomic statement, because the two halves disagree: the start is kept
    // and the counter moves. Recomputing the start on every failing run would
    // push the half-hour notice away exactly as fast as the outage lasted.
    expect(collection.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ _id: conversationId }),
      [
        {
          $set: {
            "extraction.parkedSince": {
              $ifNull: ["$extraction.parkedSince", repliedAt],
            },
            "extraction.parkedRuns": {
              $add: [{ $ifNull: ["$extraction.parkedRuns", 0] }, 1],
            },
            updatedAt: { $max: ["$updatedAt", repliedAt] },
          },
        },
      ],
      { returnDocument: "after" },
    );
  });

  it("records the parked notice once and reports the second attempt unchanged", async () => {
    const alreadyTold = feedbackConversation({
      extraction: {
        cursorSeq: 0,
        lastRunAt: null,
        model: null,
        usage: null,
        serviceTier: null,
        parkedSince: repliedAt,
        parkedRuns: 7,
        parkedNoticeSentAt: repliedAt,
      },
    });
    const collection = collectionMock({
      findOneAndUpdate: vi.fn().mockResolvedValue(null),
      findOne: vi.fn().mockResolvedValue(alreadyTold),
    });
    const repository = createRepository(collection);

    await expect(
      repository.markExtractionParkedNoticeSent({
        conversationId,
        at: repliedAt,
      }),
    ).resolves.toEqual(expect.objectContaining({ changed: false }));
    // The guard is what makes "once" true across hours of wake-ups, and it
    // accepts a document written before the field existed.
    expect(collection.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        $or: [
          { "extraction.parkedNoticeSentAt": null },
          { "extraction.parkedNoticeSentAt": { $exists: false } },
        ],
      }),
      expect.objectContaining({
        $set: { "extraction.parkedNoticeSentAt": repliedAt },
      }),
      { returnDocument: "after" },
    );
  });

  it("advances goal statuses and never reopens an answered goal", async () => {
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
          {
            "goal0.key": "liked",
            // asked is reachable from pending, and from skipped when a hold
            // question reopens a banked decline (WP-9δ).
            "goal0.status": { $in: ["pending", "skipped"] },
          },
        ],
      },
    );
  });

  it("reopens a skipped goal to asked when the bot's hold question lands", async () => {
    // Χαρά / rule 9δ: skip banked, then a question-shaped reply asks about the
    // same goal. Without this demotion the ladder stays terminal under the
    // live question and the thanks-only turn closes the conversation.
    const conversation = feedbackConversation({
      goals: [
        {
          key: "event_score",
          ordinal: 1,
          prompt: "score;",
          status: "answered",
        },
        { key: "liked", ordinal: 2, prompt: "liked;", status: "answered" },
        {
          key: "meet_again",
          ordinal: 3,
          prompt: "meet;",
          status: "answered",
        },
        { key: "avoid", ordinal: 4, prompt: "avoid;", status: "skipped" },
      ],
    });
    const collection = collectionMock({
      findOne: vi.fn().mockResolvedValue(conversation),
      findOneAndUpdate: vi.fn().mockResolvedValue({
        ...conversation,
        goals: [
          conversation.goals[0],
          conversation.goals[1],
          conversation.goals[2],
          { ...conversation.goals[3], status: "asked" },
        ],
      }),
    });
    const repository = createRepository(collection);

    const result = await repository.updateGoalStatuses({
      conversationId,
      statuses: [{ key: "avoid", status: "asked" }],
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
          {
            "goal0.key": "avoid",
            "goal0.status": { $in: ["pending", "skipped"] },
          },
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

  it("clears stopped-without-answers when an in-flight extraction records an answer", async () => {
    const stale = attentionReason({
      kind: "stopped_without_answers",
      resolvedAt: null,
      resolvedBy: null,
    });
    const stopped = feedbackConversation({
      lifecycle: {
        state: "closed",
        reason: "stopped",
        closedAt: repliedAt,
      },
      needsAttention: true,
      attentionReasons: [stale],
    });
    const answered = {
      ...stopped,
      goals: stopped.goals.map((goal, index) =>
        index === 0 ? { ...goal, status: "answered" as const } : goal,
      ),
    };
    const resolved = {
      ...answered,
      attentionReasons: [
        {
          ...stale,
          resolvedAt: repliedAt,
          resolvedBy: "system:feedback_extraction",
        },
      ],
    };
    const collection = collectionMock({
      findOne: vi.fn().mockResolvedValue(stopped),
      findOneAndUpdate: vi
        .fn()
        .mockResolvedValueOnce(answered)
        .mockResolvedValueOnce(resolved)
        .mockResolvedValueOnce({ ...resolved, needsAttention: false }),
    });
    const repository = createRepository(collection);

    const result = await repository.updateGoalStatuses({
      conversationId,
      statuses: [{ key: "event_score", status: "answered" }],
      at: repliedAt,
    });

    expect(result).toMatchObject({
      changed: true,
      conversation: {
        needsAttention: false,
        attentionReasons: [
          {
            id: stale.id,
            kind: "stopped_without_answers",
            resolvedAt: repliedAt,
            resolvedBy: "system:feedback_extraction",
          },
        ],
      },
    });
  });

  it("keeps unrelated attention when reconciling a stopped conversation", async () => {
    const stoppedReason = attentionReason({
      kind: "stopped_without_answers",
      resolvedAt: null,
      resolvedBy: null,
    });
    const safetyReason = attentionReason({
      id: secondReasonId,
      kind: "safety",
      resolvedAt: null,
      resolvedBy: null,
    });
    const stopped = feedbackConversation({
      lifecycle: {
        state: "closed",
        reason: "stopped",
        closedAt: repliedAt,
      },
      needsAttention: true,
      attentionReasons: [stoppedReason, safetyReason],
    });
    const answered = {
      ...stopped,
      goals: stopped.goals.map((goal, index) =>
        index === 0 ? { ...goal, status: "answered" as const } : goal,
      ),
    };
    const resolved = {
      ...answered,
      attentionReasons: [
        {
          ...stoppedReason,
          resolvedAt: repliedAt,
          resolvedBy: "system:feedback_extraction",
        },
        safetyReason,
      ],
    };
    const collection = collectionMock({
      findOne: vi.fn().mockResolvedValue(stopped),
      findOneAndUpdate: vi
        .fn()
        .mockResolvedValueOnce(answered)
        .mockResolvedValueOnce(resolved),
    });
    const repository = createRepository(collection);

    const result = await repository.updateGoalStatuses({
      conversationId,
      statuses: [{ key: "event_score", status: "answered" }],
      at: repliedAt,
    });

    expect(result.conversation.needsAttention).toBe(true);
    expect(
      result.conversation.attentionReasons.filter(
        (reason) => reason.resolvedAt === null,
      ),
    ).toEqual([safetyReason]);
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
          extractionParked: false,
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

  it("groups lifecycle statistics for a bounded campaign repair page", async () => {
    const secondCampaignId = "7d7d6817-e24d-43d6-92f4-b82990a61cc3";
    const cursor = {
      toArray: vi.fn().mockResolvedValue([
        {
          _id: campaignId,
          totalCount: 3,
          openCount: 0,
          latestClosedAt: repliedAt,
        },
      ]),
    };
    const collection = collectionMock({
      aggregate: vi.fn().mockReturnValue(cursor),
    });
    const repository = createRepository(collection);

    await expect(
      repository.listLifecycleStatsForCampaigns([
        campaignId,
        secondCampaignId,
        campaignId,
      ]),
    ).resolves.toEqual([
      {
        campaignId,
        totalCount: 3,
        openCount: 0,
        latestClosedAt: repliedAt,
      },
    ]);

    expect(collection.aggregate).toHaveBeenCalledWith([
      {
        $match: {
          schemaVersion: 2,
          purpose: "post_event_feedback",
          campaignId: { $in: [campaignId, secondCampaignId] },
        },
      },
      {
        $group: {
          _id: "$campaignId",
          totalCount: { $sum: 1 },
          openCount: {
            $sum: {
              $cond: [{ $eq: ["$lifecycle.state", "open"] }, 1, 0],
            },
          },
          latestClosedAt: { $max: "$lifecycle.closedAt" },
        },
      },
    ]);
  });

  it("does not open MongoDB for an empty lifecycle-statistics page", async () => {
    const collection = collectionMock({});
    const repository = createRepository(collection);

    await expect(
      repository.listLifecycleStatsForCampaigns([]),
    ).resolves.toEqual([]);
    expect(collection.aggregate).not.toHaveBeenCalled();
  });

  it("raises the badge and records why, anchored on the message to open", async () => {
    const collection = collectionMock({
      findOneAndUpdate: vi.fn().mockResolvedValue(
        feedbackConversation({
          needsAttention: true,
          attentionReasons: [attentionReason({ kind: "safety" })],
        }),
      ),
    });
    const repository = createRepository(collection);

    const result = await repository.raiseAttention({
      conversationId,
      kind: "safety",
      messageId,
      at: repliedAt,
    });

    expect(result.changed).toBe(true);
    const [filter, update] = collection.findOneAndUpdate.mock.calls[0] as [
      Record<string, unknown>,
      Record<string, Record<string, unknown>>,
    ];
    // Idempotency is the filter, not a read-then-write: two workers replaying
    // the same run race, and only one of them may push a row.
    expect(filter["attentionReasons"]).toEqual({
      $not: { $elemMatch: { kind: "safety", messageId, resolvedAt: null } },
    });
    expect(update["$set"]).toEqual({ needsAttention: true });
    expect(update["$push"]?.["attentionReasons"]).toMatchObject({
      kind: "safety",
      messageId,
      at: repliedAt,
      resolvedAt: null,
      resolvedBy: null,
    });
  });

  it("does not stack a second row for a reason already standing", async () => {
    const standing = feedbackConversation({
      needsAttention: true,
      attentionReasons: [attentionReason({ kind: "safety" })],
    });
    const collection = collectionMock({
      findOneAndUpdate: vi.fn().mockResolvedValue(null),
      findOne: vi.fn().mockResolvedValue(standing),
    });
    const repository = createRepository(collection);

    const result = await repository.raiseAttention({
      conversationId,
      kind: "safety",
      messageId,
      at: repliedAt,
    });

    // A retried job says the same thing twice; the operator must not have to
    // dismiss it twice.
    expect(result.changed).toBe(false);
    expect(result.conversation.attentionReasons).toHaveLength(1);
  });

  it("lowers the badge when the reason resolved was the last one standing", async () => {
    const resolvedAll = feedbackConversation({
      needsAttention: true,
      attentionReasons: [
        attentionReason({ kind: "safety", resolvedAt: repliedAt }),
      ],
    });
    const lowered = feedbackConversation({
      needsAttention: false,
      attentionReasons: resolvedAll.attentionReasons,
    });
    const collection = collectionMock({
      findOneAndUpdate: vi
        .fn()
        .mockResolvedValueOnce(resolvedAll)
        .mockResolvedValueOnce(lowered),
    });
    const repository = createRepository(collection);

    const result = await repository.resolveAttentionReason({
      conversationId,
      reasonId,
      resolvedBy: "admin-1",
      at: repliedAt,
    });

    expect(result.changed).toBe(true);
    expect(result.conversation.needsAttention).toBe(false);
    expect(collection.findOneAndUpdate).toHaveBeenCalledTimes(2);
    expect(collection.findOneAndUpdate.mock.calls[1]?.[1]).toMatchObject({
      $set: { needsAttention: false },
    });
  });

  it("keeps the badge up while another reason is still unresolved", async () => {
    const collection = collectionMock({
      findOneAndUpdate: vi.fn().mockResolvedValue(
        feedbackConversation({
          needsAttention: true,
          attentionReasons: [
            attentionReason({ kind: "answer_revision", resolvedAt: repliedAt }),
            attentionReason({ kind: "safety", id: secondReasonId }),
          ],
        }),
      ),
    });
    const repository = createRepository(collection);

    const result = await repository.resolveAttentionReason({
      conversationId,
      reasonId,
      resolvedBy: "admin-1",
      at: repliedAt,
    });

    // Clearing a revised score must never take a disclosure down with it.
    expect(result.changed).toBe(true);
    expect(result.conversation.needsAttention).toBe(true);
    expect(collection.findOneAndUpdate).toHaveBeenCalledTimes(1);
  });

  it("reports a missing conversation instead of inventing one", async () => {
    const collection = collectionMock({
      findOne: vi.fn().mockResolvedValue(null),
    });
    const repository = createRepository(collection);

    await expect(
      repository.raiseAttention({
        conversationId,
        kind: "safety",
        messageId,
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

/**
 * The pipeline expression one reported component compiles to.
 *
 * Spelled out here rather than imported so that a change to the accumulation
 * statement has to be made twice, deliberately. What it says: start from zero
 * when this conversation has no usage document yet, from the stored component
 * when it does — and if that component is already null, stay null, because the
 * tokens it stands for were never counted and adding to them would invent a bill.
 */
function usageIncrement(component: string, reported: number): unknown {
  return {
    $let: {
      vars: {
        prior: {
          $cond: [
            { $eq: [{ $type: "$extraction.usage" }, "object"] },
            { $ifNull: [`$extraction.usage.${component}`, null] },
            0,
          ],
        },
      },
      in: {
        $cond: [
          { $eq: ["$$prior", null] },
          null,
          { $add: ["$$prior", reported] },
        ],
      },
    },
  };
}

function collectionMock(
  overrides: Partial<Collection<FeedbackConversationDocument>>,
): Collection<FeedbackConversationDocument> & {
  readonly aggregate: ReturnType<typeof vi.fn>;
  readonly createIndexes: ReturnType<typeof vi.fn>;
  readonly findOne: ReturnType<typeof vi.fn>;
  readonly findOneAndUpdate: ReturnType<typeof vi.fn>;
  readonly insertOne: ReturnType<typeof vi.fn>;
  readonly updateMany: ReturnType<typeof vi.fn>;
  readonly updateOne: ReturnType<typeof vi.fn>;
} {
  return {
    aggregate: vi.fn(),
    createIndexes: vi.fn().mockResolvedValue([]),
    findOne: vi.fn().mockResolvedValue(null),
    findOneAndUpdate: vi.fn().mockResolvedValue(null),
    insertOne: vi.fn().mockResolvedValue({ acknowledged: true }),
    updateMany: vi.fn().mockResolvedValue({ modifiedCount: 0 }),
    updateOne: vi.fn().mockResolvedValue({ matchedCount: 1, modifiedCount: 1 }),
    ...overrides,
  } as unknown as Collection<FeedbackConversationDocument> & {
    readonly aggregate: ReturnType<typeof vi.fn>;
    readonly createIndexes: ReturnType<typeof vi.fn>;
    readonly findOne: ReturnType<typeof vi.fn>;
    readonly findOneAndUpdate: ReturnType<typeof vi.fn>;
    readonly insertOne: ReturnType<typeof vi.fn>;
    readonly updateMany: ReturnType<typeof vi.fn>;
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
    extraction: {
      cursorSeq: 0,
      lastRunAt: null,
      model: null,
      usage: null,
      serviceTier: null,
      parkedSince: null,
      parkedRuns: 0,
      parkedNoticeSentAt: null,
    },
    needsAttention: false,
    attentionReasons: [],
    remindedAt: null,
    reminderCount: 0,
    awaitingHuman: false,
    hostileTurns: 0,
    extractionFallbackAckSent: false,
    createdAt: launchedAt,
    updatedAt: repliedAt,
    ...overrides,
  };
}

function attentionReason(
  overrides: Partial<
    FeedbackConversationDocument["attentionReasons"][number]
  > = {},
): FeedbackConversationDocument["attentionReasons"][number] {
  const resolvedAt = overrides.resolvedAt ?? null;
  return {
    id: reasonId,
    kind: "safety",
    messageId,
    at: repliedAt,
    resolvedBy: resolvedAt === null ? null : "admin-1",
    ...overrides,
    resolvedAt,
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
    attention: null,
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
    attention: null,
    at: launchedAt,
  };
}
