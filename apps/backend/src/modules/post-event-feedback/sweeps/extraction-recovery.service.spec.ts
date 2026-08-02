import { Logger } from "@nestjs/common";
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { FeedbackConversationRepository } from "../post-event-feedback-conversation.repository.js";
import type { FeedbackConversationDocument } from "../post-event-feedback-conversation.document.js";
import { buildFeedbackConversationGoals } from "../post-event-feedback-conversation.document.js";
import {
  createFeedbackExtractJobId,
  createFeedbackExtractParkedJobId,
  FEEDBACK_EXTRACTION_PARK_MAX_MS,
  FEEDBACK_EXTRACTION_PARK_RETRY_MS,
  FEEDBACK_JOB_NAMES,
} from "../jobs.schemas.js";
import { FeedbackExtractionRecoveryService } from "./extraction-recovery.service.js";

const conversationId = "6f0f2f8a-2b73-5a02-9d0a-3f0b8f5b1c21";
const now = new Date("2026-08-03T12:00:00.000Z");

describe("FeedbackExtractionRecoveryService", () => {
  beforeAll(() => Logger.overrideLogger(false));

  it("recreates a missing extraction job from the unread Mongo cursor", async () => {
    const conversation = unreadConversation();
    const { service, queue, conversations } = createService(conversation);

    const result = await service.recover("periodic-recovery", now);

    expect(result).toEqual({
      examined: 1,
      requeued: 1,
      healthy: 0,
      intentionallyParked: 0,
      failed: 0,
    });
    expect(queue.add).toHaveBeenCalledWith(
      FEEDBACK_JOB_NAMES.extractV1,
      {
        schemaVersion: 1,
        conversationId,
        correlationId: `periodic-recovery-${conversationId}`,
      },
      expect.objectContaining({
        jobId: createFeedbackExtractJobId(conversationId, 2),
        delay: 0,
      }),
    );
    expect(
      conversations.listOpenBotConversationsWithUnreadParticipantMessages,
    ).toHaveBeenCalledWith({
      limit: 50,
      parkedAfter: new Date(now.getTime() - FEEDBACK_EXTRACTION_PARK_MAX_MS),
    });
  });

  it("leaves a viable delayed job alone", async () => {
    const delayed = job("delayed");
    const { service, queue } = createService(unreadConversation(), delayed);

    const result = await service.recover("periodic-recovery", now);

    expect(result.healthy).toBe(1);
    expect(queue.add).not.toHaveBeenCalled();
    expect(delayed.remove).not.toHaveBeenCalled();
  });

  it("removes a retained failed identity before requeueing it", async () => {
    const failed = job("failed");
    const { service, queue } = createService(unreadConversation(), failed);

    const result = await service.recover("periodic-recovery", now);

    expect(result.requeued).toBe(1);
    expect(failed.remove).toHaveBeenCalledOnce();
    expect(queue.add).toHaveBeenCalledOnce();
  });

  it("does not turn the bounded parked ladder into an infinite retry", async () => {
    const conversation = unreadConversation({
      parkedSince: new Date(now.getTime() - FEEDBACK_EXTRACTION_PARK_MAX_MS),
      parkedRuns: 72,
    });
    const { service, queue } = createService(conversation);

    const result = await service.recover("periodic-recovery", now);

    expect(result.intentionallyParked).toBe(1);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it("recreates a lost parked retry without turning it into a five-attempt burst", async () => {
    const conversation = unreadConversation({
      parkedSince: new Date(now.getTime() - 60_000),
      parkedRuns: 3,
    });
    const { service, queue } = createService(conversation);

    const result = await service.recover("periodic-recovery", now);

    expect(result.requeued).toBe(1);
    expect(queue.add).toHaveBeenCalledWith(
      FEEDBACK_JOB_NAMES.extractV1,
      expect.any(Object),
      {
        jobId: createFeedbackExtractParkedJobId(conversationId, 2, 3),
        delay: FEEDBACK_EXTRACTION_PARK_RETRY_MS,
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: true,
        stackTraceLimit: 10,
      },
    );
  });

  it("rechecks lifecycle before recreating work", async () => {
    const listed = unreadConversation();
    const closed = {
      ...listed,
      lifecycle: {
        state: "closed" as const,
        reason: "completed" as const,
        closedAt: now,
      },
    };
    const { service, queue } = createService(listed, null, closed);

    const result = await service.recover("periodic-recovery", now);

    expect(result.healthy).toBe(1);
    expect(queue.add).not.toHaveBeenCalled();
  });
});

function createService(
  listed: FeedbackConversationDocument,
  existingJob: ReturnType<typeof job> | null = null,
  reloaded: FeedbackConversationDocument = listed,
) {
  const queue = {
    getJob: vi.fn().mockResolvedValue(existingJob),
    add: vi.fn().mockResolvedValue({
      id: createFeedbackExtractJobId(conversationId, 2),
    }),
  };
  const conversations = {
    listOpenBotConversationsWithUnreadParticipantMessages: vi
      .fn()
      .mockResolvedValue([listed]),
    findById: vi.fn().mockResolvedValue(reloaded),
  };
  return {
    service: new FeedbackExtractionRecoveryService(
      queue as never,
      conversations as unknown as FeedbackConversationRepository,
    ),
    queue,
    conversations,
  };
}

function job(state: string) {
  return {
    getState: vi.fn().mockResolvedValue(state),
    remove: vi.fn().mockResolvedValue(undefined),
    failedReason: state === "failed" ? "worker died" : undefined,
    timestamp: now.getTime() - 60_000,
    opts: { delay: 0 },
  };
}

function unreadConversation(
  extraction: {
    parkedSince?: Date | null;
    parkedRuns?: number;
  } = {},
): FeedbackConversationDocument {
  const createdAt = new Date("2026-08-03T10:00:00.000Z");
  return {
    _id: conversationId,
    schemaVersion: 2,
    purpose: "post_event_feedback",
    channel: "whatsapp",
    campaignId: "89eccaa5-9ce6-4dcf-a630-5e35e4ec6f0d",
    respondentParticipantId: "aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
    phoneAtLaunch: "+306900000001",
    lifecycle: { state: "open", reason: null, closedAt: null },
    control: { mode: "bot", source: "launch", changedAt: createdAt },
    goals: buildFeedbackConversationGoals(),
    messages: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        seq: 1,
        actor: "bot",
        text: "Πώς πέρασες;",
        providerMessageId: null,
        ingressId: null,
        outboxId: "22222222-2222-4222-8222-222222222222",
        attention: null,
        at: createdAt,
      },
      {
        id: "33333333-3333-4333-8333-333333333333",
        seq: 2,
        actor: "participant",
        text: "Καλά ήταν",
        providerMessageId: "provider-1",
        ingressId: "44444444-4444-4444-8444-444444444444",
        outboxId: null,
        attention: null,
        at: new Date("2026-08-03T10:01:00.000Z"),
      },
    ],
    extraction: {
      cursorSeq: 1,
      lastRunAt: null,
      model: null,
      serviceTier: null,
      usage: null,
      parkedSince: extraction.parkedSince ?? null,
      parkedRuns: extraction.parkedRuns ?? 0,
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
    updatedAt: new Date("2026-08-03T10:01:00.000Z"),
  };
}
