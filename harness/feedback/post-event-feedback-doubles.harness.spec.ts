import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  FEEDBACK_CONVERSATION_MAX_MESSAGES_BYTES,
  type FeedbackConversationDocument,
  type FeedbackConversationMessage,
  buildFeedbackConversationGoals,
  deriveFeedbackConversationId,
} from "../../apps/backend/src/modules/post-event-feedback/post-event-feedback-conversation.document.js";
import { FeedbackConversationCapacityError } from "../../apps/backend/src/modules/post-event-feedback/post-event-feedback-conversation.repository.js";
import {
  applyAdvanceCursorAndMarkAwaitingHuman,
  applyClose,
  applyMarkAwaitingHuman,
} from "../../apps/backend/src/modules/post-event-feedback/post-event-feedback-conversation.state.js";
import { FakeFeedbackConversations } from "./post-event-feedback-doubles.harness.js";

const campaignId = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const respondentParticipantId = "9f3c1a52-6e2b-4b4a-9a17-2cb2a6d13a55";
const conversationId = deriveFeedbackConversationId(
  campaignId,
  respondentParticipantId,
);
const launchedAt = new Date("2026-07-25T10:00:00.000Z");
const repliedAt = new Date("2026-07-25T10:05:00.000Z");
const outboxId = "d4a4b3c2-8f1e-4d3c-9b2a-1e0f9d8c7b6a";
const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

describe("FakeFeedbackConversations production state contract", () => {
  it("refuses the human-control awaiting-human brake", async () => {
    const conversations = new FakeFeedbackConversations();
    conversations.seed(
      document({
        control: {
          mode: "human",
          source: "staff_action",
          changedAt: launchedAt,
        },
        work: { revision: 4, nextActionAt: repliedAt, executionEpoch: 2 },
      }),
    );

    const expected = applyMarkAwaitingHuman(
      conversations.get(conversationId),
      repliedAt,
    );
    const result = await conversations.markAwaitingHuman({
      conversationId,
      at: repliedAt,
    });

    expect(result.changed).toBe(false);
    expect(result.changed).toBe(expected.changed);
    expect(result.conversation.awaitingHuman).toBe(false);
    expect(result.conversation.control.mode).toBe("human");
    expect(result.conversation.work?.nextActionAt).toEqual(repliedAt);
  });

  it("admits a newer-testimony handoff on the same simulated execution", async () => {
    const conversations = new FakeFeedbackConversations();
    conversations.seed(
      document({
        messages: [botMessage(1), participantMessage(2), participantMessage(3)],
        extraction: emptyExtraction({ cursorSeq: 2 }),
        work: { revision: 5, nextActionAt: repliedAt, executionEpoch: 8 },
      }),
    );

    const expected = applyAdvanceCursorAndMarkAwaitingHuman(
      conversations.get(conversationId),
      {
        toSeq: 2,
        at: repliedAt,
        model: "m",
        serviceTier: null,
        usage,
        expectedWork: { revision: 4, epoch: 8 },
        fenceEpoch: 8,
      },
    );
    const result = await conversations.advanceCursorAndMarkAwaitingHuman({
      conversationId,
      toSeq: 2,
      at: repliedAt,
      model: "m",
      serviceTier: null,
      usage,
      workRevision: 4,
      executionEpoch: 8,
    });

    expect(result.changed).toBe(true);
    expect(result.changed).toBe(expected.changed);
    expect(result.conversation.awaitingHuman).toBe(true);
    expect(result.conversation.extraction.cursorSeq).toBe(2);
  });

  it("does not treat the caller's expected epoch as the simulated fence", async () => {
    const conversations = new FakeFeedbackConversations();
    conversations.seed(
      document({
        messages: [botMessage(1), participantMessage(2), participantMessage(3)],
        extraction: emptyExtraction({ cursorSeq: 2 }),
        work: { revision: 5, nextActionAt: repliedAt, executionEpoch: 7 },
      }),
    );

    const result = await conversations.advanceCursorAndMarkAwaitingHuman({
      conversationId,
      toSeq: 2,
      at: repliedAt,
      model: "m",
      serviceTier: null,
      usage,
      workRevision: 4,
      executionEpoch: 8,
    });

    expect(result.changed).toBe(false);
    expect(result.conversation.awaitingHuman).toBe(false);
  });

  it("clears a staff-close label when STOP overrides", async () => {
    const conversations = new FakeFeedbackConversations();
    conversations.seed(document());
    await conversations.close({
      conversationId,
      reason: "cancelled",
      at: launchedAt,
      staffClose: { reason: "abusive", note: "note" },
    });

    const expected = applyClose(conversations.get(conversationId), {
      reason: "stopped",
      at: repliedAt,
      terminalOutboxId: outboxId,
      staffClose: null,
    });
    const result = await conversations.close({
      conversationId,
      reason: "stopped",
      at: repliedAt,
      terminalOutboxId: outboxId,
      staffClose: null,
    });

    expect(result.changed).toBe(true);
    expect(result.changed).toBe(expected.changed);
    expect(result.conversation.staffClose).toBeNull();
    expect(result.conversation.lifecycle.reason).toBe("stopped");
  });

  it("refuses expected epoch 0 when the simulated execution row is missing", async () => {
    const conversations = new FakeFeedbackConversations();
    conversations.seed(
      document({
        messages: [botMessage(1), participantMessage(2)],
        extraction: emptyExtraction(),
        work: { revision: 4, nextActionAt: null, executionEpoch: 0 },
      }),
    );
    conversations.setExecutionFence(conversationId, undefined);

    const result = await conversations.advanceCursor({
      conversationId,
      toSeq: 2,
      at: repliedAt,
      model: "m",
      workRevision: 4,
      executionEpoch: 0,
    });

    expect(result.changed).toBe(false);
    expect(result.conversation.extraction.cursorSeq).toBe(0);
  });

  it("admits expected epoch 0 only when a real epoch-0 execution row exists", async () => {
    const conversations = new FakeFeedbackConversations();
    conversations.seed(
      document({
        messages: [botMessage(1), participantMessage(2)],
        extraction: emptyExtraction(),
        work: { revision: 4, nextActionAt: null, executionEpoch: 0 },
      }),
    );

    const admitted = await conversations.advanceCursor({
      conversationId,
      toSeq: 2,
      at: repliedAt,
      model: "m",
      workRevision: 4,
      executionEpoch: 0,
    });
    expect(admitted.changed).toBe(true);
    expect(admitted.conversation.extraction.cursorSeq).toBe(2);
  });

  it("consults the simulated row, not the joined work projection", async () => {
    const conversations = new FakeFeedbackConversations();
    const held = conversations.seed(
      document({
        messages: [botMessage(1), participantMessage(2)],
        extraction: emptyExtraction(),
        work: { revision: 4, nextActionAt: null, executionEpoch: 0 },
      }),
    );
    conversations.setExecutionFence(conversationId, 3);

    const wrongProjection = await conversations.advanceCursor({
      conversationId,
      toSeq: 2,
      at: repliedAt,
      model: "m",
      workRevision: 4,
      executionEpoch: 0,
    });
    expect(wrongProjection.changed).toBe(false);
    expect(conversations.get(conversationId)).toBe(held);

    const actualRow = await conversations.advanceCursor({
      conversationId,
      toSeq: 2,
      at: repliedAt,
      model: "m",
      workRevision: 4,
      executionEpoch: 3,
    });
    expect(actualRow.changed).toBe(true);
    expect(actualRow.conversation.extraction.cursorSeq).toBe(2);
    expect(conversations.get(conversationId).work?.executionEpoch).toBe(0);
  });

  it("rejects attention growth that would exceed the JSON byte budget and leaves messages unchanged", async () => {
    const conversations = new FakeFeedbackConversations();
    const messages = messagesJustUnderByteBudget();
    const target = messages.find((message) => message.actor === "participant");
    if (!target) {
      throw new Error("capacity fixture needs a participant turn");
    }
    conversations.seed(document({ messages }));
    const held = conversations.get(conversationId);

    await expect(
      conversations.mergeMessageAttention({
        conversationId,
        messageId: target.id,
        categories: ["harassment", "sexual_misconduct"],
        recommendedAction: "human_follow_up",
        confidence: 0.99,
        at: repliedAt,
      }),
    ).rejects.toBeInstanceOf(FeedbackConversationCapacityError);

    expect(conversations.get(conversationId)).toBe(held);
    expect(
      conversations
        .get(conversationId)
        .messages.find((message) => message.id === target.id)?.attention,
    ).toBeNull();
    expect(
      conversations
        .get(conversationId)
        .attentionReasons.some((reason) => reason.kind === "transcript_full"),
    ).toBe(true);
  });
});

function document(
  overrides: Partial<FeedbackConversationDocument> = {},
): FeedbackConversationDocument {
  return {
    _id: conversationId,
    schemaVersion: 2,
    purpose: "post_event_feedback",
    channel: "whatsapp",
    campaignId,
    respondentParticipantId,
    phoneAtLaunch: "+306900000000",
    lifecycle: { state: "open", reason: null, closedAt: null },
    control: { mode: "bot", source: "launch", changedAt: launchedAt },
    goals: buildFeedbackConversationGoals(),
    messages: [],
    extraction: emptyExtraction(),
    work: { revision: 0, nextActionAt: null, executionEpoch: 0 },
    needsAttention: false,
    attentionReasons: [],
    remindedAt: null,
    reminderCount: 0,
    awaitingHuman: false,
    hostileTurns: 0,
    extractionFallbackAckSent: false,
    createdAt: launchedAt,
    updatedAt: launchedAt,
    ...overrides,
  };
}

function emptyExtraction(
  overrides: Partial<FeedbackConversationDocument["extraction"]> = {},
): FeedbackConversationDocument["extraction"] {
  return {
    cursorSeq: 0,
    lastRunAt: null,
    model: null,
    usage: null,
    serviceTier: null,
    parkedSince: null,
    parkedRuns: 0,
    parkedNoticeSentAt: null,
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
    attention: null,
    at: launchedAt,
  };
}

function participantMessage(
  seq: number,
  text = "Πέρασα τέλεια!",
): FeedbackConversationMessage {
  return {
    id: randomUUID(),
    seq,
    actor: "participant",
    text,
    providerMessageId: null,
    ingressId: randomUUID(),
    outboxId: null,
    attention: null,
    at: launchedAt,
  };
}

function messagesJustUnderByteBudget(): FeedbackConversationMessage[] {
  const messages: FeedbackConversationMessage[] = [botMessage(1)];
  const overhead = 180;
  while (messages.length < 150) {
    const room =
      FEEDBACK_CONVERSATION_MAX_MESSAGES_BYTES -
      80 -
      Buffer.byteLength(JSON.stringify(messages));
    if (room <= overhead + 8) {
      break;
    }
    const textLen = Math.min(64_000, room - overhead);
    messages.push(participantMessage(messages.length + 1, "x".repeat(textLen)));
    if (textLen < 64_000) {
      break;
    }
  }
  const target = messages.findLast(
    (message) => message.actor === "participant",
  );
  if (!target) {
    throw new Error("capacity fixture needs a participant turn");
  }
  while (
    Buffer.byteLength(JSON.stringify(messages)) >
    FEEDBACK_CONVERSATION_MAX_MESSAGES_BYTES - 48
  ) {
    target.text = target.text.slice(0, -1);
  }
  const headroom =
    FEEDBACK_CONVERSATION_MAX_MESSAGES_BYTES -
    Buffer.byteLength(JSON.stringify(messages));
  if (headroom > 200) {
    throw new Error(`capacity fixture left ${headroom} bytes of headroom`);
  }
  return messages;
}
