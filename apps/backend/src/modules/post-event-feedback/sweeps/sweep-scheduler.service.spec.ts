import type { Queue } from "bullmq";
import { describe, expect, it, vi } from "vitest";

import { FEEDBACK_JOB_NAMES } from "../jobs.schemas.js";
import {
  FEEDBACK_SWEEP_EVERY_MS,
  FeedbackSweepSchedulerService,
} from "./sweep-scheduler.service.js";

describe("FeedbackSweepSchedulerService", () => {
  it("upserts one maintenance tick and deletes the three legacy schedules", async () => {
    const legacy = {
      removeJobScheduler: vi.fn().mockResolvedValue(true),
    };
    const maintenance = {
      upsertJobScheduler: vi.fn().mockResolvedValue(undefined),
    };
    const scheduler = new FeedbackSweepSchedulerService(
      legacy as unknown as Queue,
      maintenance as unknown as Queue,
    );

    await scheduler.onApplicationBootstrap();

    expect(maintenance.upsertJobScheduler).toHaveBeenCalledWith(
      FEEDBACK_JOB_NAMES.maintenanceV2,
      { every: FEEDBACK_SWEEP_EVERY_MS },
      expect.objectContaining({
        name: FEEDBACK_JOB_NAMES.maintenanceV2,
        data: {
          schemaVersion: 2,
          correlationId: FEEDBACK_JOB_NAMES.maintenanceV2,
        },
      }),
    );
    expect(legacy.removeJobScheduler.mock.calls.map(([id]) => id)).toEqual([
      FEEDBACK_JOB_NAMES.sweepRemindersV1,
      FEEDBACK_JOB_NAMES.sweepExpiryV1,
      FEEDBACK_JOB_NAMES.sweepIngressV1,
    ]);
  });
});
