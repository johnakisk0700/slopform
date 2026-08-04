import type { Job, Queue } from "bullmq";
import type { AppTransaction } from "@join-the-six/database";
import { describe, expect, it, vi } from "vitest";

import type { DatabaseService } from "../../../infrastructure/database/database.service.js";
import type { FeedbackConversationRepository } from "../post-event-feedback-conversation.repository.js";
import type {
  FeedbackConversationRecoveryCursor,
  FeedbackMaintenanceCheckpointRepository,
} from "../sweeps/maintenance-checkpoint.repository.js";
import {
  createFeedbackReconcileConversationJobId,
  FEEDBACK_JOB_NAMES,
  type FeedbackJobData,
  type FeedbackJobName,
} from "../jobs.schemas.js";
import {
  FEEDBACK_RECONCILIATION_RECOVERY_SCAN_LIMIT,
  FeedbackConversationWakeupService,
} from "./wakeup.service.js";
import { FEEDBACK_RECONCILIATION_INVARIANT_FAILURE_REASON } from "./reconcile-failure.js";

const conversationId = "6f0f2f8a-2b73-5a02-9d0a-3f0b8f5b1c21";
const now = new Date("2026-08-03T12:00:00.000Z");
const due = new Date("2026-08-03T12:00:45.000Z");

describe("FeedbackConversationWakeupService", () => {
  it("persists a new revision before enqueueing its delayed wake-up", async () => {
    const { service, queue, conversations } = createService();
    conversations.markWorkDue.mockResolvedValue({
      changed: true,
      conversation: {} as never,
      work: { revision: 4, nextActionAt: due, executionEpoch: 2 },
    });

    await expect(
      service.schedule({
        conversationId,
        nextActionAt: due,
        correlationId: "c",
        at: now,
      }),
    ).resolves.toBe(
      createFeedbackReconcileConversationJobId(conversationId, 4),
    );

    expect(conversations.markWorkDue).toHaveBeenCalledBefore(queue.add);
    expect(queue.add).toHaveBeenCalledWith(
      FEEDBACK_JOB_NAMES.reconcileConversationV2,
      {
        schemaVersion: 2,
        conversationId,
        revision: 4,
        correlationId: "c",
      },
      expect.objectContaining({
        jobId: createFeedbackReconcileConversationJobId(conversationId, 4),
        delay: 45_000,
      }),
    );
  });

  it("replaces a retained terminal wake-up only while durable work is still due", async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    const { service, queue } = createService({
      getJob: vi.fn().mockResolvedValue({
        getState: vi.fn().mockResolvedValue("failed"),
        failedReason: "MongoDB temporarily unavailable",
        remove,
      } as unknown as Job),
    });

    await service.ensureQueued({
      conversationId,
      work: { revision: 4, nextActionAt: due, executionEpoch: 2 },
      correlationId: "c",
      now,
    });

    expect(remove).toHaveBeenCalledOnce();
    expect(queue.add).toHaveBeenCalledOnce();
  });

  it("keeps the exact current-revision invariant failure quarantined while retained", async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    const { service, queue } = createService({
      getJob: vi.fn().mockResolvedValue({
        getState: vi.fn().mockResolvedValue("failed"),
        failedReason: FEEDBACK_RECONCILIATION_INVARIANT_FAILURE_REASON,
        remove,
      } as unknown as Job),
    });

    await expect(
      service.ensureQueued({
        conversationId,
        work: { revision: 4, nextActionAt: due, executionEpoch: 2 },
        correlationId: "maintenance",
        now,
      }),
    ).resolves.toBe(
      createFeedbackReconcileConversationJobId(conversationId, 4),
    );

    expect(remove).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it("leaves a retained failed wake-up untouched after terminal work is cleared", async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    const getJob = vi.fn().mockResolvedValue({
      getState: vi.fn().mockResolvedValue("failed"),
      remove,
    } as unknown as Job);
    const { service, queue } = createService({ getJob });

    await expect(
      service.ensureQueued({
        conversationId,
        work: { revision: 4, nextActionAt: null, executionEpoch: 2 },
        correlationId: "terminal-fallback",
        now,
      }),
    ).resolves.toBeUndefined();

    expect(getJob).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it("bootstraps one bounded legacy batch before recovering due revisions", async () => {
    const { service, conversations } = createService();
    conversations.seedMissingWork.mockResolvedValue(100);

    await expect(service.recoverDue("maintenance", now)).resolves.toEqual({
      examined: 0,
      queued: 0,
    });

    expect(conversations.seedMissingWork).toHaveBeenCalledBefore(
      conversations.listDueWork,
    );
    expect(conversations.repairLegacyAwaitingHuman).toHaveBeenCalledBefore(
      conversations.seedMissingWork,
    );
    expect(conversations.repairLegacyAwaitingHuman).toHaveBeenCalledWith({
      at: now,
      limit: 100,
    });
    expect(conversations.seedMissingWork).toHaveBeenCalledWith({
      dueAt: now,
      limit: 100,
    });
    expect(conversations.listDueWork).toHaveBeenCalledWith({
      dueAt: now,
      limit: 100,
    });
  });

  it("still recovers native V2 work when compatibility seeding fails", async () => {
    const { service, conversations } = createService();
    conversations.seedMissingWork.mockRejectedValue(
      new Error("legacy bootstrap query failed"),
    );

    await expect(service.recoverDue("maintenance", now)).resolves.toEqual({
      examined: 0,
      queued: 0,
    });

    expect(conversations.listDueWork).toHaveBeenCalledWith({
      dueAt: now,
      limit: 100,
    });
  });

  it("still recovers native V2 work when the cursor-first bridge fails", async () => {
    const { service, conversations } = createService();
    conversations.repairLegacyAwaitingHuman.mockRejectedValue(
      new Error("legacy repair query failed"),
    );

    await expect(service.recoverDue("maintenance", now)).resolves.toEqual({
      examined: 0,
      queued: 0,
    });

    expect(conversations.seedMissingWork).toHaveBeenCalledOnce();
    expect(conversations.listDueWork).toHaveBeenCalledWith({
      dueAt: now,
      limit: 100,
    });
  });

  it("keyset-pages beyond an oldest prefix whose wake-ups are already live", async () => {
    const { service, conversations } = createService();
    const firstPage = Array.from({ length: 100 }, (_, index) =>
      dueConversation(index + 1),
    );
    const beyondFirstPage = dueConversation(101);
    conversations.listDueWork
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce([beyondFirstPage]);
    const ensureQueued = vi
      .spyOn(service, "ensureQueued")
      .mockResolvedValue("already-live-or-added");

    await expect(service.recoverDue("maintenance", now)).resolves.toEqual({
      examined: 101,
      queued: 101,
    });

    expect(conversations.listDueWork).toHaveBeenNthCalledWith(2, {
      dueAt: now,
      limit: 100,
      after: {
        nextActionAt: firstPage[99]?.work?.nextActionAt,
        conversationId: firstPage[99]?._id,
      },
    });
    expect(ensureQueued).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: beyondFirstPage._id }),
    );
  });

  it("bounds each global pass and continues from its keyset cursor next time", async () => {
    const { service, conversations } = createService();
    conversations.listDueWork.mockImplementation(
      (input: { after?: { conversationId: string } }) => {
        const start = input.after
          ? Number.parseInt(input.after.conversationId.slice(-12), 10) + 1
          : 1;
        return Promise.resolve(
          Array.from({ length: 100 }, (_, index) =>
            dueConversation(start + index),
          ),
        );
      },
    );
    vi.spyOn(service, "ensureQueued").mockResolvedValue("already-live");

    await expect(service.recoverDue("maintenance", now)).resolves.toEqual({
      examined: FEEDBACK_RECONCILIATION_RECOVERY_SCAN_LIMIT,
      queued: FEEDBACK_RECONCILIATION_RECOVERY_SCAN_LIMIT,
    });
    await expect(service.recoverDue("maintenance-next", now)).resolves.toEqual({
      examined: FEEDBACK_RECONCILIATION_RECOVERY_SCAN_LIMIT,
      queued: FEEDBACK_RECONCILIATION_RECOVERY_SCAN_LIMIT,
    });

    expect(conversations.listDueWork).toHaveBeenCalledTimes(10);
    expect(conversations.listDueWork).toHaveBeenNthCalledWith(6, {
      dueAt: now,
      limit: 100,
      after: {
        nextActionAt: dueConversation(500).work.nextActionAt,
        conversationId: dueConversation(500)._id,
      },
    });
  });

  it("shares its durable checkpoint across worker replicas", async () => {
    const shared = checkpointDouble();
    const first = createService({ checkpoints: shared });
    const second = createService({ checkpoints: shared });
    first.conversations.listDueWork.mockImplementation(
      (input: { after?: { conversationId: string } }) => {
        const start = input.after
          ? Number.parseInt(input.after.conversationId.slice(-12), 10) + 1
          : 1;
        return Promise.resolve(
          Array.from({ length: 100 }, (_, index) =>
            dueConversation(start + index),
          ),
        );
      },
    );
    second.conversations.listDueWork.mockResolvedValue([]);
    vi.spyOn(first.service, "ensureQueued").mockResolvedValue("already-live");

    await first.service.recoverDue("replica-a", now);
    await second.service.recoverDue("replica-b", now);

    expect(second.conversations.listDueWork).toHaveBeenCalledWith({
      dueAt: now,
      limit: 100,
      after: {
        nextActionAt: dueConversation(500).work.nextActionAt,
        conversationId: dueConversation(500)._id,
      },
    });
  });

  it("advances the checkpoint before publishing and isolates item failures", async () => {
    const { service, conversations, checkpoints } = createService();
    const firstPage = Array.from({ length: 100 }, (_, index) =>
      dueConversation(index + 1),
    );
    conversations.listDueWork.mockResolvedValueOnce(firstPage);
    vi.spyOn(service, "ensureQueued")
      .mockRejectedValueOnce(new Error("redis unavailable"))
      .mockResolvedValue("queued");

    await expect(service.recoverDue("maintenance", now)).resolves.toEqual({
      examined: 100,
      queued: 99,
    });

    expect(checkpoints.saveConversationDue).toHaveBeenCalledBefore(
      vi.mocked(service.ensureQueued),
    );
    expect(service.ensureQueued).toHaveBeenCalledTimes(100);
  });
});

function dueConversation(ordinal: number) {
  return {
    _id: `00000000-0000-4000-8000-${String(ordinal).padStart(12, "0")}`,
    work: {
      revision: 1,
      nextActionAt: new Date(now.getTime() - 1_000 + ordinal),
      executionEpoch: 0,
    },
  };
}

function createService(
  overrides: {
    getJob?: ReturnType<typeof vi.fn>;
    checkpoints?: ReturnType<typeof checkpointDouble>;
  } = {},
) {
  const queue = {
    getJob: overrides.getJob ?? vi.fn().mockResolvedValue(undefined),
    add: vi.fn().mockResolvedValue(undefined),
  };
  const conversations = {
    markWorkDue: vi.fn(),
    repairLegacyAwaitingHuman: vi.fn().mockResolvedValue(0),
    seedMissingWork: vi.fn().mockResolvedValue(0),
    listDueWork: vi.fn().mockResolvedValue([]),
  };
  const transaction = {} as AppTransaction;
  const database = {
    transaction: vi.fn(async (work: (tx: AppTransaction) => Promise<unknown>) =>
      work(transaction),
    ),
  };
  const checkpoints = overrides.checkpoints ?? checkpointDouble();
  return {
    service: new FeedbackConversationWakeupService(
      queue as unknown as Queue<FeedbackJobData, void, FeedbackJobName>,
      conversations as unknown as FeedbackConversationRepository,
      database as unknown as DatabaseService,
      checkpoints as unknown as FeedbackMaintenanceCheckpointRepository,
    ),
    queue,
    conversations,
    database,
    checkpoints,
  };
}

function checkpointDouble(initial?: FeedbackConversationRecoveryCursor): {
  readonly lockConversationDue: ReturnType<typeof vi.fn>;
  readonly saveConversationDue: ReturnType<typeof vi.fn>;
} {
  let cursor = initial;
  return {
    lockConversationDue: vi.fn().mockImplementation(async () => cursor),
    saveConversationDue: vi
      .fn()
      .mockImplementation(
        async (
          _transaction: AppTransaction,
          next: FeedbackConversationRecoveryCursor | undefined,
        ) => {
          cursor = next;
        },
      ),
  };
}
