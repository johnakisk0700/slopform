import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  buildFeedbackConversationGoals,
  deriveFeedbackConversationId,
  feedbackConversationDocumentSchema,
  type FeedbackConversationDocument,
  type FeedbackConversationMessage,
} from "../post-event-feedback-conversation.document.js";
import {
  buildOutboundConversationSnapshot,
  outboundConversationSnapshotSchema,
} from "./outbound-log.snapshot.js";

const campaignId = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const respondentParticipantId = "9f3c1a52-6e2b-4b4a-9a17-2cb2a6d13a55";
const createdAt = new Date("2026-07-25T10:00:00.000Z");
const updatedAt = new Date("2026-07-25T10:30:00.000Z");
const closedAt = new Date("2026-07-25T11:00:00.000Z");

describe("buildOutboundConversationSnapshot", () => {
  it("summarises an open bot-controlled conversation with pending goals", () => {
    const conversation = conversationDocument({
      messages: [botMessage(1), participantMessage(2)],
      extraction: {
        cursorSeq: 2,
        lastRunAt: updatedAt,
        model: "test-model",
        usage: null,
        serviceTier: null,
        parkedSince: null,
        parkedRuns: 0,
        parkedNoticeSentAt: null,
      },
      reminderCount: 1,
      remindedAt: updatedAt,
    });

    const snapshot = buildOutboundConversationSnapshot(conversation);

    expect(snapshot).toEqual({
      lifecycle: { state: "open", reason: null },
      control: { mode: "bot", source: "launch" },
      awaitingHuman: false,
      needsAttention: false,
      unresolvedAttentionCount: 0,
      goals: conversation.goals.map((goal) => ({
        key: goal.key,
        status: goal.status,
      })),
      messageCount: 2,
      latestMessageSeq: 2,
      extractionCursorSeq: 2,
      reminderCount: 1,
    });
    expect(outboundConversationSnapshotSchema.parse(snapshot)).toEqual(
      snapshot,
    );
  });

  it("carries a closed lifecycle reason and human control mode", () => {
    const conversation = conversationDocument({
      lifecycle: {
        state: "closed",
        reason: "cancelled",
        closedAt,
      },
      control: {
        mode: "human",
        source: "staff_action",
        changedAt: updatedAt,
      },
      awaitingHuman: false,
      messages: [botMessage(1)],
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
    });

    const snapshot = buildOutboundConversationSnapshot(conversation);

    expect(snapshot.lifecycle).toEqual({
      state: "closed",
      reason: "cancelled",
    });
    expect(snapshot.control).toEqual({
      mode: "human",
      source: "staff_action",
    });
    expect(outboundConversationSnapshotSchema.parse(snapshot)).toEqual(
      snapshot,
    );
  });

  it("counts only unresolved attention reasons and copies needsAttention", () => {
    const conversation = conversationDocument({
      needsAttention: true,
      attentionReasons: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          kind: "safety",
          messageId: null,
          at: updatedAt,
          resolvedAt: null,
          resolvedBy: null,
        },
        {
          id: "22222222-2222-4222-8222-222222222222",
          kind: "handoff",
          messageId: null,
          at: updatedAt,
          resolvedAt: updatedAt,
          resolvedBy: "admin-1",
        },
        {
          id: "33333333-3333-4333-8333-333333333333",
          kind: "unattributed_note",
          messageId: null,
          at: updatedAt,
          resolvedAt: null,
          resolvedBy: null,
        },
      ],
    });

    const snapshot = buildOutboundConversationSnapshot(conversation);

    expect(snapshot.needsAttention).toBe(true);
    expect(snapshot.unresolvedAttentionCount).toBe(2);
    expect(outboundConversationSnapshotSchema.parse(snapshot)).toEqual(
      snapshot,
    );
  });

  it("reports an empty transcript as zero messages and a null latest seq", () => {
    const conversation = conversationDocument({ messages: [] });

    const snapshot = buildOutboundConversationSnapshot(conversation);

    expect(snapshot.messageCount).toBe(0);
    expect(snapshot.latestMessageSeq).toBeNull();
    expect(snapshot.extractionCursorSeq).toBe(0);
    expect(outboundConversationSnapshotSchema.parse(snapshot)).toEqual(
      snapshot,
    );
  });
});

function conversationDocument(
  overrides: Partial<FeedbackConversationDocument> = {},
): FeedbackConversationDocument {
  return feedbackConversationDocumentSchema.parse({
    _id: deriveFeedbackConversationId(campaignId, respondentParticipantId),
    schemaVersion: 2,
    purpose: "post_event_feedback",
    channel: "whatsapp",
    campaignId,
    respondentParticipantId,
    phoneAtLaunch: "+306900000000",
    lifecycle: { state: "open", reason: null, closedAt: null },
    control: { mode: "bot", source: "launch", changedAt: createdAt },
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
    staffClose: null,
    createdAt,
    updatedAt,
    ...overrides,
  });
}

function botMessage(seq: number): FeedbackConversationMessage {
  return {
    id: randomUUID(),
    seq,
    actor: "bot",
    text: "Πώς σου φάνηκε η βραδιά;",
    providerMessageId: null,
    ingressId: null,
    outboxId: randomUUID(),
    attention: null,
    at: createdAt,
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
    at: createdAt,
  };
}
