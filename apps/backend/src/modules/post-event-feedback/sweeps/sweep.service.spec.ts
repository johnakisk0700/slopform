import { describe, expect, it, vi } from "vitest";

import type { ConfigService } from "@nestjs/config";

import type { Environment } from "../../../infrastructure/config/environment.js";
import type { DatabaseService } from "../../../infrastructure/database/database.service.js";
import type { FeedbackIngressRepository } from "../ingress/ingress.repository.js";
import type { FeedbackMaterializeWakeupService } from "../ingress/materialize-wakeup.service.js";
import type {
  FeedbackMaintenanceCheckpointRepository,
  FeedbackPendingIngressRecoveryCursor,
} from "./maintenance-checkpoint.repository.js";
import { PostEventFeedbackSweepService } from "./sweep.service.js";

const ingressId = "b1c9e0a4-2c65-4a29-9a2e-2d0a3f2e1b77";

describe("PostEventFeedbackSweepService", () => {
  it("re-enqueues stuck pending ingress rows under the stable job id", async () => {
    const { service, repository, materializeWakeups, checkpoints } =
      createService();
    const stuckAt = new Date("2026-07-25T00:00:00.000Z");
    repository.listPendingIngressOlderThan.mockResolvedValue([
      {
        id: ingressId,
        processingStatus: "pending",
        createdAt: stuckAt,
      },
    ]);

    const result = await service.sweepIngress(
      "corr-1",
      new Date("2026-07-25T00:10:00.000Z"),
    );

    expect(result).toEqual({ examined: 1, requeued: 1, failed: 0 });
    expect(repository.listPendingIngressOlderThan).toHaveBeenCalledWith(
      {
        olderThan: new Date("2026-07-25T00:05:00.000Z"),
        limit: 50,
      },
      expect.anything(),
    );
    expect(checkpoints.savePendingIngress).toHaveBeenCalledBefore(
      materializeWakeups.ensurePendingQueued,
    );
    expect(materializeWakeups.ensurePendingQueued).toHaveBeenCalledWith({
      ingressId,
      correlationId: `corr-1:${ingressId}`,
    });
  });

  it("reports a terminal-job repair race as failed so maintenance retries it", async () => {
    const { service, repository, materializeWakeups } = createService();
    repository.listPendingIngressOlderThan.mockResolvedValue([
      {
        id: ingressId,
        processingStatus: "pending",
        createdAt: new Date("2026-07-25T00:00:00.000Z"),
      },
    ]);
    materializeWakeups.ensurePendingQueued.mockRejectedValue(
      new Error("terminal removal lost an unresolved race"),
    );

    await expect(
      service.sweepIngress("corr-race", new Date("2026-07-25T00:10:00.000Z")),
    ).resolves.toEqual({ examined: 1, requeued: 0, failed: 1 });
  });

  it("passes 50 poison rows after an allocated-page crash and wraps finitely", async () => {
    const { service, repository, materializeWakeups } = createService();
    const rows = Array.from({ length: 51 }, (_, index) =>
      pendingIngress(index + 1),
    );
    repository.listPendingIngressOlderThan.mockImplementation(
      async (input: {
        olderThan: Date;
        limit: number;
        after?: FeedbackPendingIngressRecoveryCursor;
      }) =>
        rows
          .filter(
            (row) =>
              row.createdAt <= input.olderThan &&
              (!input.after ||
                row.createdAt > input.after.createdAt ||
                (row.createdAt.getTime() === input.after.createdAt.getTime() &&
                  row.id > input.after.ingressId)),
          )
          .slice(0, input.limit),
    );
    materializeWakeups.ensurePendingQueued.mockImplementation(
      async ({ ingressId: candidateId }: { ingressId: string }) => {
        if (candidateId !== rows[50]?.id) {
          throw new Error("poison ingress");
        }
        return `feedback-materialize-v1-${candidateId}`;
      },
    );

    // The process commits allocation of rows 1..50 and dies before publishing.
    const allocated = await (
      service as unknown as {
        allocatePendingIngressRecoveryPage(olderThan: Date): Promise<unknown[]>;
      }
    ).allocatePendingIngressRecoveryPage(INGRESS_RECOVERY_CUTOFF);
    expect(allocated).toHaveLength(50);
    expect(materializeWakeups.ensurePendingQueued).not.toHaveBeenCalled();

    // A new pass/replica starts beyond that committed page and reaches row 51.
    await expect(
      service.sweepIngress("after-crash", INGRESS_RECOVERY_NOW),
    ).resolves.toEqual({ examined: 1, requeued: 1, failed: 0 });
    expect(materializeWakeups.ensurePendingQueued).toHaveBeenCalledWith({
      ingressId: rows[50]?.id,
      correlationId: `after-crash:${rows[50]?.id}`,
    });

    materializeWakeups.ensurePendingQueued.mockClear();
    await expect(
      service.sweepIngress("after-wrap", INGRESS_RECOVERY_NOW),
    ).resolves.toEqual({ examined: 50, requeued: 0, failed: 50 });
    expect(materializeWakeups.ensurePendingQueued).toHaveBeenCalledWith({
      ingressId: rows[0]?.id,
      correlationId: `after-wrap:${rows[0]?.id}`,
    });
  });
});

const INGRESS_RECOVERY_NOW = new Date("2026-07-25T00:10:00.000Z");
const INGRESS_RECOVERY_CUTOFF = new Date("2026-07-25T00:05:00.000Z");

function pendingIngress(ordinal: number) {
  return {
    id: `00000000-0000-4000-8000-${String(ordinal).padStart(12, "0")}`,
    processingStatus: "pending" as const,
    createdAt: new Date(INGRESS_RECOVERY_CUTOFF.getTime() - 60_000 + ordinal),
  };
}

function createService(): {
  service: PostEventFeedbackSweepService;
  repository: {
    listPendingIngressOlderThan: ReturnType<typeof vi.fn>;
  };
  materializeWakeups: {
    ensurePendingQueued: ReturnType<typeof vi.fn>;
  };
  checkpoints: {
    lockPendingIngress: ReturnType<typeof vi.fn>;
    savePendingIngress: ReturnType<typeof vi.fn>;
  };
} {
  const repository = {
    listPendingIngressOlderThan: vi.fn().mockResolvedValue([]),
  };
  const materializeWakeups = {
    ensurePendingQueued: vi
      .fn()
      .mockResolvedValue(`feedback-materialize-v1-${ingressId}`),
  };
  const config = {
    get: vi.fn((key: keyof Environment) => {
      if (key === "FEEDBACK_INGRESS_PENDING_RECOVERY_MINUTES") return 5;
      return undefined;
    }),
  };
  let transactionSeq = 0;
  const database = {
    transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) =>
      work({ n: ++transactionSeq }),
    ),
  };
  const checkpoints = pendingIngressCheckpointDouble();

  return {
    service: new PostEventFeedbackSweepService(
      materializeWakeups as unknown as FeedbackMaterializeWakeupService,
      config as unknown as ConfigService<Environment, true>,
      database as unknown as DatabaseService,
      checkpoints as unknown as FeedbackMaintenanceCheckpointRepository,
      repository as unknown as FeedbackIngressRepository,
    ),
    repository,
    materializeWakeups,
    checkpoints,
  };
}

function pendingIngressCheckpointDouble(
  initial?: FeedbackPendingIngressRecoveryCursor,
): {
  readonly lockPendingIngress: ReturnType<typeof vi.fn>;
  readonly savePendingIngress: ReturnType<typeof vi.fn>;
} {
  let cursor = initial;
  return {
    lockPendingIngress: vi.fn().mockImplementation(async () => cursor),
    savePendingIngress: vi
      .fn()
      .mockImplementation(
        async (
          _transaction: unknown,
          next: FeedbackPendingIngressRecoveryCursor | undefined,
        ) => {
          cursor = next;
        },
      ),
  };
}
