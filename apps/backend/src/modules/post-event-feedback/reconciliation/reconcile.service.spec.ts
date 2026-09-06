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

import type { AppTransaction } from "@slopform/database";

import type { Environment } from "../../../infrastructure/config/environment.js";
import type { DatabaseService } from "../../../infrastructure/database/database.service.js";
import type { ParticipantsRepository } from "../../participants/participants.repository.js";
import type { FeedbackCampaignRepository } from "../campaign/campaign.repository.js";
import type { FeedbackConversationExecutionFence } from "../extraction/execution-fence.service.js";
import type {
  FeedbackConversationExecutionClaim,
  FeedbackConversationExecutionFenceRepository,
} from "../extraction/execution-fence.repository.js";
import {
  FeedbackConversationExecutionGuardError,
  type PostEventFeedbackExtractor,
} from "../extraction/extract.service.js";
import { FEEDBACK_OPERATION_EVENT } from "../feedback-operation-log.js";
import { createFeedbackReconcileConversationJobId } from "../jobs.schemas.js";
import {
  buildFeedbackConversationGoals,
  type FeedbackConversationDocument,
  type FeedbackConversationMessage,
} from "../post-event-feedback-conversation.document.js";
import type { FeedbackOutboxRepository } from "../outbox/outbox.repository.js";
import type { FeedbackConversationRepository } from "../post-event-feedback-conversation.repository.js";
import type { FeedbackConversationInactivityService } from "./conversation-inactivity.service.js";
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
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("returns claim_busy without a lease when another execution owns the fence", async () => {
    const harness = createHarness();
    harness.executionClaims.tryClaim.mockResolvedValue(undefined);

    await expect(harness.service.reconcile(input)).resolves.toBe("claim_busy");

    expect(harness.conversations.findByIdForUpdate).toHaveBeenCalledOnce();
    expect(harness.executionFence.startHeartbeat).not.toHaveBeenCalled();
    expect(harness.executionFence.release).not.toHaveBeenCalled();
  });

  it("rejects a stale revision in the same transaction as the lease attempt", async () => {
    const harness = createHarness();
    const newer = conversation({
      work: {
        revision: input.revision + 1,
        nextActionAt: now,
        executionEpoch: claim.epoch - 1,
      },
    });
    harness.conversations.findByIdForUpdate
      .mockReset()
      .mockResolvedValue(newer);

    await expect(harness.service.reconcile(input)).resolves.toBe(
      "stale_revision",
    );

    expect(harness.executionClaims.tryClaim).not.toHaveBeenCalled();
    expect(harness.extractor.extract).not.toHaveBeenCalled();
    expect(harness.conversations.settleWorkExecution).not.toHaveBeenCalled();
    expect(harness.executionFence.startHeartbeat).not.toHaveBeenCalled();
    expect(harness.executionFence.release).not.toHaveBeenCalled();
  });

  it("admits the work revision in the same short transaction as the lease claim", async () => {
    const harness = createHarness();

    await expect(harness.service.reconcile(input)).resolves.toBe("settled");

    const admissionTx =
      harness.conversations.findByIdForUpdate.mock.calls[0]?.[0];
    expect(harness.executionClaims.tryClaim).toHaveBeenCalledWith(
      admissionTx,
      expect.objectContaining({
        conversationId,
        workRevision: input.revision,
      }),
    );
    expect(
      harness.conversations.settleWorkExecution.mock.calls[0]?.[0],
    ).not.toBe(admissionTx);
    expect(harness.extractor.extract).toHaveBeenCalled();
    expect(
      harness.executionClaims.tryClaim.mock.invocationCallOrder[0],
    ).toBeLessThan(harness.extractor.extract.mock.invocationCallOrder[0]!);
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
    expect(harness.inactivity.remindConversation).not.toHaveBeenCalled();
    expect(harness.inactivity.expireConversation).not.toHaveBeenCalled();
    expect(harness.conversations.settleWorkExecution).toHaveBeenCalledWith(
      expect.anything(),
      {
        conversationId,
        revision: input.revision,
        epoch: claim.epoch,
        nextActionAt: reminderAt,
        at: now,
      },
    );
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

  it("preserves newer work when its revision changed during execution", async () => {
    const harness = createHarness();
    harness.conversations.settleWorkExecution.mockResolvedValue({
      changed: false,
    });
    await expect(harness.service.reconcile(input)).resolves.toBe("superseded");
    expect(harness.wakeups.ensureQueued).not.toHaveBeenCalled();
  });

  it("cannot settle after losing the lease, even if the work revision is unchanged", async () => {
    const harness = createHarness();
    harness.executionFence.isCurrent.mockResolvedValue(false);
    await expect(harness.service.reconcile(input)).rejects.toMatchObject({
      reason: "execution_claim_lost",
    });
    expect(harness.conversations.settleWorkExecution).not.toHaveBeenCalled();
    expect(harness.wakeups.ensureQueued).not.toHaveBeenCalled();
    expect(harness.executionFence.release).toHaveBeenCalledWith(claim);
  });

  it("checks the lease in the same transaction as reading and settling current work", async () => {
    const harness = createHarness();
    await harness.service.reconcile(input);
    const settlementTx =
      harness.conversations.settleWorkExecution.mock.calls[0]?.[0];
    expect(harness.executionFence.isCurrent).toHaveBeenCalledWith(
      settlementTx,
      claim,
    );
    expect(harness.conversations.findByIdForUpdate.mock.calls[1]?.[0]).toBe(
      settlementTx,
    );
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
    const records = captureOperations();
    const harness = createHarness();
    const heartbeatFailure = new Error("heartbeat shutdown failed");
    harness.heartbeat.stop.mockRejectedValue(heartbeatFailure);

    await expect(harness.service.reconcile(input)).rejects.toBe(
      heartbeatFailure,
    );

    expect(harness.executionFence.release).toHaveBeenCalledWith(claim);
    expect(
      records.some(
        (record) =>
          record.operation === "reconcile_cleanup" &&
          record.stage === "stop_heartbeat" &&
          record.status === "failed",
      ),
    ).toBe(true);
    expect(
      records.some(
        (record) =>
          record.operation === "reconcile_cleanup" &&
          record.stage === "release_claim" &&
          record.status === "completed",
      ),
    ).toBe(true);
    expect(
      records.find(
        (record) =>
          record.operation === "reconcile" && record.status === "failed",
      ),
    ).toMatchObject({ stage: "cleanup", errorName: "Error" });
  });

  it("keeps a planning failure visible when claim cleanup also fails", async () => {
    const records = captureOperations();
    const harness = createHarness();
    const planningFailure = Object.assign(new Error("plan read failed"), {
      code: "PLAN_READ_FAILED",
    });
    const cleanupFailure = Object.assign(new Error("release failed"), {
      code: "CLAIM_RELEASE_FAILED",
    });
    harness.campaigns.findCampaignById.mockRejectedValue(planningFailure);
    harness.executionFence.release.mockRejectedValue(cleanupFailure);

    await expect(harness.service.reconcile(input)).rejects.toBe(cleanupFailure);
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operation: "reconcile",
          stage: "plan",
          status: "failed",
          errorCode: "PLAN_READ_FAILED",
        }),
        expect.objectContaining({
          operation: "reconcile_cleanup",
          stage: "release_claim",
          status: "failed",
          errorCode: "CLAIM_RELEASE_FAILED",
        }),
      ]),
    );
  });

  it("still settles when the logger sink throws", async () => {
    throwingLoggerSink();
    const harness = createHarness();

    await expect(harness.service.reconcile(input)).resolves.toBe("settled");
    expect(harness.extractor.extract).toHaveBeenCalled();
    expect(harness.wakeups.ensureQueued).toHaveBeenCalled();
    expect(harness.executionFence.release).toHaveBeenCalledWith(claim);
  });

  it("names execute_action when the planned action throws and keeps that error", async () => {
    const records = captureOperations();
    const harness = createHarness();
    const failure = Object.assign(
      new Error("provider temporarily unavailable"),
      {
        code: "ETIMEDOUT",
      },
    );
    harness.extractor.extract.mockRejectedValue(failure);

    await expect(harness.service.reconcile(input)).rejects.toBe(failure);
    expect(
      records.find(
        (record) =>
          record.operation === "reconcile" && record.status === "failed",
      ),
    ).toMatchObject({
      stage: "execute_action",
      errorName: "Error",
      errorCode: "ETIMEDOUT",
      conversationId,
      workRevision: input.revision,
    });
  });

  it("records authoritative supersession as a classified completed outcome", async () => {
    const records = captureOperations();
    const harness = createHarness();
    harness.extractor.extract.mockRejectedValue(
      new FeedbackConversationExecutionGuardError(
        conversationId,
        "authoritative_state_changed",
      ),
    );

    await expect(harness.service.reconcile(input)).resolves.toBe("superseded");
    expect(
      records.find(
        (record) =>
          record.operation === "reconcile" && record.status !== "started",
      ),
    ).toMatchObject({
      stage: "execute_action",
      status: "completed",
      outcome: "superseded",
    });
    expect(
      records.some(
        (record) =>
          record.operation === "reconcile" && record.status === "failed",
      ),
    ).toBe(false);
  });

  it("keeps a settled return when successor enqueue fails", async () => {
    const records = captureOperations();
    const harness = createHarness();
    const enqueueError = Object.assign(new Error("redis down"), {
      code: "ECONNREFUSED",
    });
    harness.wakeups.ensureQueued.mockRejectedValue(enqueueError);

    await expect(harness.service.reconcile(input)).resolves.toBe("settled");
    expect(
      records.find(
        (record) =>
          record.operation === "reconcile" && record.status === "completed",
      ),
    ).toMatchObject({
      stage: "enqueue_successor",
      outcome: "settled",
    });
    expect(
      records.some(
        (record) =>
          record.stage === "settle_work" && record.status === "failed",
      ),
    ).toBe(false);
    expect(
      records.some(
        (record) =>
          record.stage === "enqueue_successor" &&
          record.status === "failed" &&
          record.errorCode === "ECONNREFUSED",
      ),
    ).toBe(true);
  });
});

function captureOperations(): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  const collect = (message: unknown) => {
    if (
      message !== null &&
      typeof message === "object" &&
      "event" in message &&
      message.event === FEEDBACK_OPERATION_EVENT
    ) {
      records.push(message as Record<string, unknown>);
    }
  };
  vi.spyOn(Logger.prototype, "log").mockImplementation(collect);
  vi.spyOn(Logger.prototype, "error").mockImplementation(collect);
  vi.spyOn(Logger.prototype, "warn").mockImplementation(collect);
  return records;
}

function throwingLoggerSink(): void {
  const boom = () => {
    throw new Error("pino unavailable");
  };
  vi.spyOn(Logger.prototype, "log").mockImplementation(boom);
  vi.spyOn(Logger.prototype, "error").mockImplementation(boom);
  vi.spyOn(Logger.prototype, "warn").mockImplementation(boom);
}

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
    findByIdForUpdate: vi
      .fn()
      .mockResolvedValueOnce(initial)
      .mockResolvedValue(afterExtraction),
    findById: vi.fn().mockResolvedValue(afterExtraction),
    settleWorkExecution: vi.fn().mockResolvedValue({
      changed: true,
      conversation: { ...afterExtraction, work: settledWork },
      work: settledWork,
    }),
  };
  const heartbeat = { stop: vi.fn().mockResolvedValue(undefined) };
  const executionClaims = {
    tryClaim: vi.fn().mockResolvedValue(claim),
  };
  const executionFence = {
    isCurrent: vi.fn().mockResolvedValue(true),
    startHeartbeat: vi.fn().mockReturnValue(heartbeat),
    release: vi.fn().mockResolvedValue(true),
  };
  let transactionSeq = 0;
  const database = {
    transaction: vi.fn(async (work: (tx: AppTransaction) => Promise<unknown>) =>
      work({ n: ++transactionSeq } as unknown as AppTransaction),
    ),
  };
  const extractor = { extract: vi.fn().mockResolvedValue(undefined) };
  const inactivity = {
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
    database as unknown as DatabaseService,
    campaigns as unknown as FeedbackCampaignRepository,
    participants as unknown as ParticipantsRepository,
    conversations as unknown as FeedbackConversationRepository,
    { lockConversation: vi.fn() } as unknown as FeedbackOutboxRepository,
    executionClaims as unknown as FeedbackConversationExecutionFenceRepository,
    executionFence as unknown as FeedbackConversationExecutionFence,
    extractor as unknown as PostEventFeedbackExtractor,
    inactivity as unknown as FeedbackConversationInactivityService,
    wakeups as unknown as FeedbackConversationWakeupService,
  );
  return {
    service,
    campaigns,
    conversations,
    executionClaims,
    executionFence,
    heartbeat,
    extractor,
    inactivity,
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
