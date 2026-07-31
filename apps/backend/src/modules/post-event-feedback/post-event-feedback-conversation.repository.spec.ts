import { randomUUID } from "node:crypto";

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
        needsAttention: false,
        attentionReasons: [],
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
