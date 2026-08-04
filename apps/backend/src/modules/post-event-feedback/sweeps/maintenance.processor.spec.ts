import { Logger } from "@nestjs/common";
import { UnrecoverableError, type Job } from "bullmq";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  FEEDBACK_JOB_NAMES,
  type FeedbackJobData,
  type FeedbackJobName,
} from "../jobs.schemas.js";
import type { PostEventFeedbackMaintenanceService } from "./maintenance.service.js";
import { PostEventFeedbackMaintenanceProcessor } from "./maintenance.processor.js";

describe("PostEventFeedbackMaintenanceProcessor", () => {
  beforeAll(() => Logger.overrideLogger(false));

  it("runs the single maintenance contract", async () => {
    const maintenance = {
      run: vi.fn().mockResolvedValue({ completed: [], failed: [] }),
    };
    const processor = new PostEventFeedbackMaintenanceProcessor(
      maintenance as unknown as PostEventFeedbackMaintenanceService,
    );

    await processor.process(createJob());

    expect(maintenance.run).toHaveBeenCalledWith("maintenance-v2");
  });

  it("does not retry malformed scheduler payloads", async () => {
    const maintenance = { run: vi.fn() };
    const processor = new PostEventFeedbackMaintenanceProcessor(
      maintenance as unknown as PostEventFeedbackMaintenanceService,
    );

    await expect(
      processor.process(
        createJob({ schemaVersion: 1, correlationId: "maintenance-v2" }),
      ),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect(maintenance.run).not.toHaveBeenCalled();
  });
});

function createJob(
  data: FeedbackJobData = {
    schemaVersion: 2,
    correlationId: "maintenance-v2",
  },
): Job<FeedbackJobData, void, FeedbackJobName> {
  return {
    id: "repeat:feedback.maintenance.v2:1",
    name: FEEDBACK_JOB_NAMES.maintenanceV2,
    data,
    attemptsMade: 0,
    opts: { attempts: 1 },
  } as Job<FeedbackJobData, void, FeedbackJobName>;
}
