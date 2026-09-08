import type { AppTransaction, MessageOutboxRow } from "@slopform/database";
import { describe, expect, it, vi } from "vitest";

import {
  buildFeedbackConversationGoals,
  deriveFeedbackConversationId,
  feedbackConversationDocumentSchema,
  type FeedbackConversationDocument,
} from "../post-event-feedback-conversation.document.js";
import { FeedbackOutboundIntentService } from "./outbound-intent.service.js";
import type { FeedbackOutboundLogService } from "./outbound-log.service.js";
import type { FeedbackOutboxRepository } from "./outbox.repository.js";

const conversationId = deriveFeedbackConversationId(
  "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
  "9f3c1a52-6e2b-4b4a-9a17-2cb2a6d13a55",
);
const campaignId = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const createdAt = new Date("2026-07-25T10:00:00.000Z");
const transaction = {} as AppTransaction;

describe("FeedbackOutboundIntentService", () => {
  it("inserts context and records history on the supplied transaction", async () => {
    const { service, outbox, outboundLog } = createService();
    const conversation = conversationDocument();
    const row = introRow();
    outbox.insertOutboxIfAbsent.mockResolvedValue({ row, inserted: true });

    const result = await service.enqueue(transaction, {
      dispatch: { schemaVersion: 1, purpose: "campaign_intro" },
      message: {
        conversationId,
        campaignId,
        body: row.body,
        dedupeKey: `feedback-intro-${conversationId}`,
      },
      history: {
        conversation,
        decision: { origin: "campaign_intro", conversationCreated: true },
        correlationId: "corr-intro",
      },
    });

    expect(result).toEqual({ row, inserted: true });
    expect(outbox.insertOutboxIfAbsent).toHaveBeenCalledWith(transaction, {
      conversationId,
      campaignId,
      kind: "intro",
      body: row.body,
      dedupeKey: `feedback-intro-${conversationId}`,
      dispatchContext: { schemaVersion: 1, purpose: "campaign_intro" },
    });
    expect(outboundLog.record).toHaveBeenCalledWith(transaction, {
      outbox: { row, inserted: true },
      conversation,
      decision: { origin: "campaign_intro", conversationCreated: true },
      correlationId: "corr-intro",
    });
  });

  it("defers STOP history so the caller can record it after mutations", async () => {
    const { service, outbox, outboundLog } = createService();
    const conversation = conversationDocument();
    const row = introRow({
      kind: "system",
      body: "stopped",
      dedupeKey: `feedback-stop-ack-${conversationId}`,
    });
    const sourceIngressId = "e2d32755-d43f-42eb-a209-d731d1dd47d7";
    outbox.insertOutboxIfAbsent.mockResolvedValue({ row, inserted: true });

    const inserted = await service.enqueue(transaction, {
      dispatch: {
        schemaVersion: 1,
        purpose: "stop_ack",
        sourceIngressId,
      },
      message: {
        conversationId,
        campaignId,
        body: row.body,
        dedupeKey: row.dedupeKey,
      },
      history: { deferred: "stop_ack_after_mutations" },
    });

    expect(outboundLog.record).not.toHaveBeenCalled();
    await service.recordHistory(transaction, {
      outbox: inserted,
      conversation,
      decision: { origin: "stop_ack", sourceIngressId },
      correlationId: "corr-stop",
    });
    expect(outboundLog.record).toHaveBeenCalledWith(
      transaction,
      expect.objectContaining({
        conversation,
        decision: { origin: "stop_ack", sourceIngressId },
      }),
    );
  });

  it("rejects a purpose/kind/dedupe mismatch before insert", async () => {
    const { service, outbox, outboundLog } = createService();

    await expect(
      service.enqueue(transaction, {
        dispatch: { schemaVersion: 1, purpose: "campaign_intro" },
        message: {
          conversationId,
          campaignId,
          body: "nope",
          dedupeKey: `feedback-reply-${conversationId}-1`,
        },
        history: {
          conversation: conversationDocument(),
          decision: { origin: "campaign_intro", conversationCreated: true },
          correlationId: "corr-mismatch",
        },
      }),
    ).rejects.toThrow(/does not match kind/);
    expect(outbox.insertOutboxIfAbsent).not.toHaveBeenCalled();
    expect(outboundLog.record).not.toHaveBeenCalled();
  });
});

function createService(): {
  service: FeedbackOutboundIntentService;
  outbox: {
    insertOutboxIfAbsent: ReturnType<typeof vi.fn>;
  };
  outboundLog: {
    record: ReturnType<typeof vi.fn>;
  };
} {
  const outbox = { insertOutboxIfAbsent: vi.fn() };
  const outboundLog = { record: vi.fn().mockResolvedValue(undefined) };
  return {
    service: new FeedbackOutboundIntentService(
      outbox as unknown as FeedbackOutboxRepository,
      outboundLog as unknown as FeedbackOutboundLogService,
    ),
    outbox,
    outboundLog,
  };
}

function introRow(overrides: Partial<MessageOutboxRow> = {}): MessageOutboxRow {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    conversationId,
    campaignId,
    kind: "intro",
    body: "Γεια σου",
    status: "pending",
    dedupeKey: `feedback-intro-${conversationId}`,
    createdByStaff: null,
    providerLogId: null,
    providerMessageId: null,
    deliveryStatus: null,
    sentAt: null,
    deliveredAt: null,
    readAt: null,
    playedAt: null,
    deliveryUpdatedAt: null,
    claimToken: null,
    claimExpiresAt: null,
    sendStartedAt: null,
    attemptCount: 0,
    lastError: null,
    createdAt,
    updatedAt: createdAt,
    dispatchContext: { schemaVersion: 1, purpose: "campaign_intro" },
    ...overrides,
  };
}

function conversationDocument(): FeedbackConversationDocument {
  return feedbackConversationDocumentSchema.parse({
    _id: conversationId,
    schemaVersion: 2,
    purpose: "post_event_feedback",
    channel: "whatsapp",
    campaignId,
    respondentParticipantId: "9f3c1a52-6e2b-4b4a-9a17-2cb2a6d13a55",
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
    updatedAt: createdAt,
  });
}
