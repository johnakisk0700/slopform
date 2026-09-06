import { FEEDBACK_CONVERSATION_MAX_MESSAGES_BYTES } from "./post-event-feedback-conversation.document.js";
import { randomUUID } from "node:crypto";

import type { FeedbackConversationRow } from "@slopform/database";
import { describe, expect, it } from "vitest";

import {
  conversationMessagesExceedCapacity,
  reviveConversationJson,
  serializeConversationJson,
  toDocument,
  toLaunchInsert,
  toRespondent,
  toRowUpdate,
  toSummary,
} from "./post-event-feedback-conversation.persistence.js";
import {
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
const messageId = "5c7e6f10-3a2b-4c1d-8e9f-0a1b2c3d4e5f";
const reasonId = "7a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d";

describe("feedback conversation persistence mapping", () => {
  it("revives only the known JSON timestamp paths", () => {
    const revived = reviveConversationJson({
      messages: [
        {
          id: messageId,
          seq: 1,
          actor: "participant",
          text: "Πέρασα τέλεια!",
          providerMessageId: null,
          ingressId: "b1c9e0a4-2c65-4a29-9a2e-2d0a3f2e1b77",
          outboxId: null,
          attention: null,
          at: repliedAt.toISOString(),
        },
      ],
      attentionReasons: [
        {
          id: reasonId,
          kind: "safety",
          messageId,
          at: repliedAt.toISOString(),
          resolvedAt: launchedAt.toISOString(),
          resolvedBy: "admin-1",
        },
      ],
    });

    expect(revived.messages[0]?.at).toEqual(repliedAt);
    expect(revived.attentionReasons[0]?.at).toEqual(repliedAt);
    expect(revived.attentionReasons[0]?.resolvedAt).toEqual(launchedAt);
  });

  it("serializes those same paths back to ISO strings", () => {
    const serialized = serializeConversationJson(
      conversation({
        messages: [participantMessage(1)],
        attentionReasons: [attentionReason()],
      }),
    );

    expect(serialized.messages[0]?.at).toBe(launchedAt.toISOString());
    expect(serialized.attentionReasons[0]?.at).toBe(repliedAt.toISOString());
    expect(serialized.attentionReasons[0]?.resolvedAt).toBeNull();
  });

  it("uses 0 for work.executionEpoch only when no fence row was joined", () => {
    const withoutFence = toDocument(rowFrom(conversation()), {});
    expect(withoutFence.work?.executionEpoch).toBe(0);

    const claimed = toDocument(rowFrom(conversation()), { executionEpoch: 4 });
    expect(claimed.work?.executionEpoch).toBe(4);

    const unclaimedFence = toDocument(rowFrom(conversation()), {
      executionEpoch: 0,
    });
    expect(unclaimedFence.work?.executionEpoch).toBe(0);
  });

  it("derives campaignResumeGeneration from the campaign column", () => {
    const document = toDocument(rowFrom(conversation()), {
      campaignResumeGeneration: 3,
    });
    expect(document.work?.campaignResumeGeneration).toBe(3);
    expect(toRowUpdate(document)).not.toHaveProperty(
      "campaignResumeGeneration",
    );
    expect(toRowUpdate(document)).not.toHaveProperty("executionEpoch");
  });

  it("does not persist a whole-document copy", () => {
    const insert = toLaunchInsert(conversation());
    expect(insert).not.toHaveProperty("document");
    expect(insert).not.toHaveProperty("schemaVersion");
    expect(insert.workRevision).toBe(0);
    expect(insert.workNextActionAt).toBeNull();
    expect(insert.messages).toEqual([]);
  });

  it("projects a compact summary without prompts or the transcript", () => {
    const document = conversation({
      goals: [
        {
          key: "event_score",
          ordinal: 1,
          prompt: "secret prompt",
          status: "asked",
        },
      ],
      messages: [participantMessage(1)],
    });
    const summary = toSummary({
      row: rowFrom(document),
      messageCount: 1,
      lastMessageAt: launchedAt.toISOString(),
      lastMessageActor: "participant",
      extractionParked: false,
    });
    expect(summary.messageCount).toBe(1);
    expect(summary.lastMessageActor).toBe("participant");
    expect(summary.goals[0]).toEqual({
      key: "event_score",
      ordinal: 1,
      status: "asked",
    });
    expect(summary.goals[0]).not.toHaveProperty("prompt");
  });

  it("projects a respondent row for outbound-queue name resolution", () => {
    expect(toRespondent(rowFrom(conversation()))).toEqual({
      _id: conversationId,
      respondentParticipantId,
      phoneAtLaunch,
    });
  });

  it("guards transcript capacity by array length and JSON bytes", () => {
    expect(conversationMessagesExceedCapacity(new Array(151).fill({}))).toBe(
      true,
    );
    expect(conversationMessagesExceedCapacity([])).toBe(false);
    const oversized = "x".repeat(FEEDBACK_CONVERSATION_MAX_MESSAGES_BYTES);
    expect(conversationMessagesExceedCapacity([{ body: oversized }])).toBe(
      true,
    );
  });
});

function conversation(
  overrides: Partial<FeedbackConversationDocument> = {},
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
    updatedAt: repliedAt,
    ...overrides,
  };
}

function rowFrom(
  document: FeedbackConversationDocument,
): FeedbackConversationRow {
  const update = toRowUpdate(document);
  return {
    id: document._id,
    campaignId: document.campaignId,
    respondentParticipantId: document.respondentParticipantId,
    phoneAtLaunch: document.phoneAtLaunch,
    createdAt: document.createdAt,
    ...update,
    lifecycleReason: update.lifecycleReason ?? null,
    closedAt: update.closedAt ?? null,
    terminalOutboxId: update.terminalOutboxId ?? null,
    staffCloseReason: update.staffCloseReason ?? null,
    staffCloseNote: update.staffCloseNote ?? null,
    remindedAt: update.remindedAt ?? null,
    extractionLastRunAt: update.extractionLastRunAt ?? null,
    extractionModel: update.extractionModel ?? null,
    extractionServiceTier: update.extractionServiceTier ?? null,
    parkedSince: update.parkedSince ?? null,
    parkedNoticeSentAt: update.parkedNoticeSentAt ?? null,
    workNextActionAt: update.workNextActionAt ?? null,
    extractionUsage: update.extractionUsage ?? null,
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
