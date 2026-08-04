import { Logger } from "@nestjs/common";
import { DelayedError, UnrecoverableError, type Job } from "bullmq";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  createFeedbackSummarizeCampaignV2JobId,
  FEEDBACK_JOB_NAMES,
  type FeedbackJobData,
  type FeedbackJobName,
} from "../jobs.schemas.js";
import type { PostEventFeedbackCampaignSummaryService } from "./summary.service.js";
import {
  FEEDBACK_SUMMARY_CLAIM_BUSY_RETRY_MS,
  FEEDBACK_SUMMARY_WORKER_CONCURRENCY,
  PostEventFeedbackSummaryProcessor,
} from "./summary.processor.js";

const campaignId = "89eccaa5-9ce6-4dcf-a630-5e35e4ec6f0d";
const data = {
  schemaVersion: 2 as const,
  campaignId,
  attempt: 3,
  correlationId: "summary-recovery",
};

describe("PostEventFeedbackSummaryProcessor", () => {
  beforeAll(() => Logger.overrideLogger(false));

  it("keeps campaign model work serial per worker process", () => {
    expect(FEEDBACK_SUMMARY_WORKER_CONCURRENCY).toBe(3);
  });

  it("runs the exact durable summary attempt encoded by the job", async () => {
    const summaries = createSummaries();
    const processor = new PostEventFeedbackSummaryProcessor(
      summaries as unknown as PostEventFeedbackCampaignSummaryService,
    );
    const job = createJob();

    await processor.process(job);

    expect(summaries.run).toHaveBeenCalledWith(data, {
      terminalOnFailure: false,
    });
  });

  it("rejects a payload or id that cannot identify the durable attempt", async () => {
    const summaries = createSummaries();
    const processor = new PostEventFeedbackSummaryProcessor(
      summaries as unknown as PostEventFeedbackCampaignSummaryService,
    );

    await expect(
      processor.process(createJob({ id: "hand-written" })),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect(summaries.run).not.toHaveBeenCalled();
  });

  it("tells the fenced service when the last retry is exhausted", async () => {
    const transient = new Error("provider timeout");
    const summaries = createSummaries();
    summaries.run.mockRejectedValue(transient);
    const processor = new PostEventFeedbackSummaryProcessor(
      summaries as unknown as PostEventFeedbackCampaignSummaryService,
    );

    await expect(
      processor.process(createJob({ attemptsMade: 4, attempts: 5 })),
    ).rejects.toBe(transient);
    expect(summaries.run).toHaveBeenCalledWith(data, {
      terminalOnFailure: true,
    });
  });

  it("delays a busy durable claim without consuming a normal attempt", async () => {
    const summaries = createSummaries();
    summaries.run.mockResolvedValue("claim_busy");
    const processor = new PostEventFeedbackSummaryProcessor(
      summaries as unknown as PostEventFeedbackCampaignSummaryService,
    );
    const job = createJob();
    const now = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);

    await expect(processor.process(job)).rejects.toBeInstanceOf(DelayedError);

    expect(job.moveToDelayed).toHaveBeenCalledWith(
      now + FEEDBACK_SUMMARY_CLAIM_BUSY_RETRY_MS,
      "worker-token",
    );
    nowSpy.mockRestore();
  });
});

function createSummaries() {
  return {
    run: vi.fn().mockResolvedValue("completed"),
  };
}

function createJob(
  options: { id?: string; attemptsMade?: number; attempts?: number } = {},
): Job<FeedbackJobData, void, FeedbackJobName> {
  return {
    id:
      options.id ??
      createFeedbackSummarizeCampaignV2JobId(campaignId, data.attempt),
    name: FEEDBACK_JOB_NAMES.summarizeCampaignV2,
    data,
    token: "worker-token",
    moveToDelayed: vi.fn().mockResolvedValue(undefined),
    attemptsMade: options.attemptsMade ?? 0,
    opts: { attempts: options.attempts ?? 5 },
  } as unknown as Job<FeedbackJobData, void, FeedbackJobName>;
}
