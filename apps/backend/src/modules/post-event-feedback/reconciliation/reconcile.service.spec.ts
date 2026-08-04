import { Logger } from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { Environment } from "../../../infrastructure/config/environment.js";
import type { ParticipantsRepository } from "../../participants/participants.repository.js";
import type { FeedbackCampaignRepository } from "../campaign/campaign.repository.js";
import type { FeedbackConversationExecutionFence } from "../extraction/execution-fence.service.js";
import type { FeedbackConversationExecutionClaim } from "../extraction/execution-fence.repository.js";
import {
  FeedbackConversationExecutionGuardError,
  type PostEventFeedbackExtractor,
} from "../extraction/extract.service.js";
import { createFeedbackReconcileConversationJobId } from "../jobs.schemas.js";
import {
  buildFeedbackConversationGoals,
  type FeedbackConversationDocument,
  type FeedbackConversationMessage,
} from "../post-event-feedback-conversation.document.js";
import type { FeedbackConversationRepository } from "../post-event-feedback-conversation.repository.js";
import type { PostEventFeedbackSweepService } from "../sweeps/sweep.service.js";
import type { FeedbackConversationWakeupService } from "./wakeup.service.js";
import { FeedbackConversationReconcileService } from "./reconcile.service.js";

const conversationId = "85b4e284-28d9-55e5-9d8b-e981671d37d2";
const campaignId = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const participantId = "9f3c1a52-6e2b-4b4a-9a17-2cb2a6d13a55";
const now = new Date("2026-08-03T12:00:00.000Z");
const messageAt = new Date("2026-08-03T11:59:00.000Z");
const reminderAt = new Date("2026-08-04T11:59:00.000Z");
const input = {
  schemaVersion: 2 as const,
  conversationId,
  revision: 5,
  correlationId: "reconcile-test",
};
const claim: FeedbackConversationExecutionClaim = {
  conversationId,
  workRevision: input.revision,
  epoch: 9,
  token: "11111111-1111-4111-8111-111111111111",
  leaseUntil: new Date("2026-08-03T12:07:00.000Z"),
};

describe("FeedbackConversationReconcileService", () => {
  beforeAll(() => Logger.overrideLogger(false));
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
  });
  afterEach(() => vi.useRealTimers());

  it("returns claim_busy without touching Mongo when another execution owns the lease", async () => {
    const harness = createHarness();
    harness.executionFence.tryClaim.mockResolvedValue(undefined);

    await expect(harness.service.reconcile(input)).resolves.toBe("claim_busy");

    expect(harness.conversations.beginWorkExecution).not.toHaveBeenCalled();
    expect(harness.executionFence.startHeartbeat).not.toHaveBeenCalled();
    expect(harness.executionFence.release).not.toHaveBeenCalled();
  });

  it("drops a stale Mongo revision and always releases the PostgreSQL claim", async () => {
    const harness = createHarness();
    const newer = conversation({
      work: {
        revision: input.revision + 1,
        nextActionAt: now,
        executionEpoch: claim.epoch - 1,
      },
    });
    harness.conversations.beginWorkExecution.mockResolvedValue({
      changed: false,
      conversation: newer,
      work: newer.work,
    });

    await expect(harness.service.reconcile(input)).resolves.toBe(
      "stale_revision",
    );

    expect(harness.extractor.extract).not.toHaveBeenCalled();
    expect(harness.conversations.settleWorkExecution).not.toHaveBeenCalled();
    expect(harness.executionFence.startHeartbeat).toHaveBeenCalledWith(claim);
    expect(harness.heartbeat.stop).toHaveBeenCalledTimes(1);
    expect(harness.executionFence.release).toHaveBeenCalledWith(claim);
  });

  it("executes exactly one planned action before settling the next wake-up", async () => {
    const harness = createHarness();

    await expect(harness.service.reconcile(input)).resolves.toBe("settled");

    expect(harness.extractor.extract).toHaveBeenCalledTimes(1);
    expect(harness.extractor.extract).toHaveBeenCalledWith({
      conversationId,
      correlationId: input.correlationId,
      executionClaim: claim,
    });
    expect(harness.sweeps.remindConversation).not.toHaveBeenCalled();
    expect(harness.sweeps.expireConversation).not.toHaveBeenCalled();
    expect(harness.conversations.settleWorkExecution).toHaveBeenCalledWith({
      conversationId,
      revision: input.revision,
      epoch: claim.epoch,
      nextActionAt: reminderAt,
      at: now,
    });
    expect(harness.wakeups.ensureQueued).toHaveBeenCalledWith({
      conversationId,
      work: {
        revision: input.revision + 1,
        nextActionAt: reminderAt,
        executionEpoch: claim.epoch,
      },
      correlationId: input.correlationId,
      now,
    });
    expect(
      createFeedbackReconcileConversationJobId(
        conversationId,
        input.revision + 1,
      ),
    ).not.toBe(
      createFeedbackReconcileConversationJobId(conversationId, input.revision),
    );
    expect(harness.heartbeat.stop).toHaveBeenCalledTimes(1);
    expect(harness.executionFence.release).toHaveBeenCalledWith(claim);
    expect(harness.heartbeat.stop.mock.invocationCallOrder[0]).toBeLessThan(
      harness.executionFence.release.mock.invocationCallOrder[0]!,
    );
  });

  it("queues the schedule returned by settlement when a newer revision arrived during execution", async () => {
    const harness = createHarness();
    const quietUntil = new Date(now.getTime() + 45_000);
    const newer = conversation({
      messages: [participantMessage(1, messageAt), participantMessage(2, now)],
      extraction: baseExtraction,
      work: {
        revision: input.revision + 1,
        nextActionAt: quietUntil,
        executionEpoch: claim.epoch,
      },
      updatedAt: now,
    });
    const preservedWork = {
      revision: input.revision + 1,
      nextActionAt: quietUntil,
      executionEpoch: claim.epoch,
    };
    harness.conversations.findById.mockResolvedValue(newer);
    harness.conversations.settleWorkExecution.mockResolvedValue({
      changed: true,
      conversation: newer,
      work: preservedWork,
    });

    await expect(harness.service.reconcile(input)).resolves.toBe("settled");

    expect(harness.extractor.extract).toHaveBeenCalledTimes(1);
    expect(harness.conversations.settleWorkExecution).toHaveBeenCalledWith({
      conversationId,
      revision: input.revision,
      epoch: claim.epoch,
      nextActionAt: quietUntil,
      at: now,
    });
    expect(harness.wakeups.ensureQueued).toHaveBeenCalledWith({
      conversationId,
      work: preservedWork,
      correlationId: input.correlationId,
      now,
    });
  });

  it("releases the claim when the planned action throws", async () => {
    const harness = createHarness();
    const failure = new Error("provider temporarily unavailable");
    harness.extractor.extract.mockRejectedValue(failure);

    await expect(harness.service.reconcile(input)).rejects.toBe(failure);

    expect(harness.conversations.settleWorkExecution).not.toHaveBeenCalled();
    expect(harness.wakeups.ensureQueued).not.toHaveBeenCalled();
    expect(harness.heartbeat.stop).toHaveBeenCalledTimes(1);
    expect(harness.executionFence.release).toHaveBeenCalledWith(claim);
  });

  it("completes authoritative state supersession without settling the obsolete revision", async () => {
    const harness = createHarness();
    harness.extractor.extract.mockRejectedValue(
      new FeedbackConversationExecutionGuardError(
        conversationId,
        "authoritative_state_changed",
      ),
    );

    await expect(harness.service.reconcile(input)).resolves.toBe("superseded");

    expect(harness.conversations.settleWorkExecution).not.toHaveBeenCalled();
    expect(harness.wakeups.ensureQueued).not.toHaveBeenCalled();
    expect(harness.heartbeat.stop).toHaveBeenCalledTimes(1);
    expect(harness.executionFence.release).toHaveBeenCalledWith(claim);
  });

  it.each(["execution_claim_lost", "execution_invariant_broken"] as const)(
    "propagates %s while still releasing the claim",
    async (reason) => {
      const harness = createHarness();
      const failure = new FeedbackConversationExecutionGuardError(
        conversationId,
        reason,
      );
      harness.extractor.extract.mockRejectedValue(failure);

      await expect(harness.service.reconcile(input)).rejects.toBe(failure);

      expect(harness.conversations.settleWorkExecution).not.toHaveBeenCalled();
      expect(harness.wakeups.ensureQueued).not.toHaveBeenCalled();
      expect(harness.heartbeat.stop).toHaveBeenCalledTimes(1);
      expect(harness.executionFence.release).toHaveBeenCalledWith(claim);
    },
  );

  it("still releases the claim if stopping its heartbeat fails", async () => {
    const harness = createHarness();
    const heartbeatFailure = new Error("heartbeat shutdown failed");
    harness.heartbeat.stop.mockRejectedValue(heartbeatFailure);

    await expect(harness.service.reconcile(input)).rejects.toBe(
      heartbeatFailure,
    );

    expect(harness.executionFence.release).toHaveBeenCalledWith(claim);
  });
});

function createHarness() {
  const initial = conversation();
  const afterExtraction = conversation({
    extraction: {
      ...baseExtraction,
      cursorSeq: 1,
      lastRunAt: now,
      model: "openai/gpt-5-mini",
    },
  });
  const settledWork = {
    revision: input.revision + 1,
    nextActionAt: reminderAt,
    executionEpoch: claim.epoch,
  };
  const conversations = {
    beginWorkExecution: vi.fn().mockResolvedValue({
      changed: true,
      conversation: initial,
      work: initial.work,
    }),
    findById: vi.fn().mockResolvedValue(afterExtraction),
    settleWorkExecution: vi.fn().mockResolvedValue({
      changed: true,
      conversation: { ...afterExtraction, work: settledWork },
      work: settledWork,
    }),
  };
  const heartbeat = { stop: vi.fn().mockResolvedValue(undefined) };
  const executionFence = {
    tryClaim: vi.fn().mockResolvedValue(claim),
    startHeartbeat: vi.fn().mockReturnValue(heartbeat),
    release: vi.fn().mockResolvedValue(true),
  };
  const extractor = { extract: vi.fn().mockResolvedValue(undefined) };
  const sweeps = {
    remindConversation: vi.fn().mockResolvedValue(undefined),
    expireConversation: vi.fn().mockResolvedValue(undefined),
  };
  const wakeups = { ensureQueued: vi.fn().mockResolvedValue(undefined) };
  const campaigns = {
    findCampaignById: vi.fn().mockResolvedValue({ status: "launched" }),
  };
  const participants = {
    findById: vi.fn().mockResolvedValue({
      postEventFeedbackWhatsappOptIn: true,
    }),
  };
  const config = {
    get: vi.fn((key: string) => {
      if (key === "FEEDBACK_REMINDER_AFTER_HOURS") return 24;
      if (key === "FEEDBACK_EXPIRE_AFTER_HOURS") return 72;
      if (key === "FEEDBACK_MAX_REMINDERS") return 2;
      throw new Error(`Unexpected config key: ${key}`);
    }),
  };

  const service = new FeedbackConversationReconcileService(
    config as unknown as ConfigService<Environment, true>,
    campaigns as unknown as FeedbackCampaignRepository,
    participants as unknown as ParticipantsRepository,
    conversations as unknown as FeedbackConversationRepository,
    executionFence as unknown as FeedbackConversationExecutionFence,
    extractor as unknown as PostEventFeedbackExtractor,
    sweeps as unknown as PostEventFeedbackSweepService,
    wakeups as unknown as FeedbackConversationWakeupService,
  );
  return {
    service,
    conversations,
    executionFence,
    heartbeat,
    extractor,
    sweeps,
    wakeups,
  };
}

const baseExtraction: FeedbackConversationDocument["extraction"] = {
  cursorSeq: 0,
  lastRunAt: null,
  model: null,
  usage: null,
  serviceTier: null,
  parkedSince: null,
  parkedRuns: 0,
  parkedNoticeSentAt: null,
};

function conversation(
  overrides: Partial<FeedbackConversationDocument> = {},
): FeedbackConversationDocument {
  return {
    _id: conversationId,
    schemaVersion: 2,
    purpose: "post_event_feedback",
    channel: "whatsapp",
    campaignId,
    respondentParticipantId: participantId,
    phoneAtLaunch: "+306900000000",
    lifecycle: { state: "open", reason: null, closedAt: null },
    control: {
      mode: "bot",
      source: "launch",
      changedAt: new Date("2026-08-03T11:00:00.000Z"),
    },
    goals: buildFeedbackConversationGoals(),
    messages: [participantMessage(1, messageAt)],
    extraction: baseExtraction,
    work: {
      revision: input.revision,
      nextActionAt: new Date("2026-08-03T11:59:45.000Z"),
      executionEpoch: claim.epoch,
    },
    needsAttention: false,
    attentionReasons: [],
    remindedAt: null,
    reminderCount: 0,
    awaitingHuman: false,
    hostileTurns: 0,
    extractionFallbackAckSent: false,
    staffClose: null,
    createdAt: new Date("2026-08-03T11:00:00.000Z"),
    updatedAt: messageAt,
    ...overrides,
  };
}

function participantMessage(
  seq: number,
  at: Date,
): FeedbackConversationMessage {
  const suffix = seq.toString().padStart(12, "0");
  return {
    id: `11111111-1111-4111-8111-${suffix}`,
    seq,
    actor: "participant",
    text: `participant ${seq}`,
    providerMessageId: null,
    ingressId: `22222222-2222-4222-8222-${suffix}`,
    outboxId: null,
    attention: null,
    at,
  };
}
