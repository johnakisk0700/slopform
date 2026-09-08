import type { Job, Queue } from "bullmq";
import { describe, expect, it, vi } from "vitest";

import { FEEDBACK_JOB_NAMES } from "../jobs.schemas.js";
import {
  FeedbackOutboxDispatchProcessor,
  nextOutboxPollInterval,
} from "./dispatch.processor.js";
import type { MessageOutboxDispatcherService } from "./dispatcher.service.js";

const emptyBatch = { claimedCount: 0, quarantinedCount: 0, items: [] };

function createProcessor() {
  const queue = {
    setGlobalConcurrency: vi.fn().mockResolvedValue(undefined),
    getJobScheduler: vi.fn().mockResolvedValue(undefined),
    upsertJobScheduler: vi.fn().mockResolvedValue(undefined),
  };
  const dispatcher = { dispatchBatch: vi.fn().mockResolvedValue(emptyBatch) };
  const processor = new FeedbackOutboxDispatchProcessor(
    queue as unknown as Queue,
    dispatcher as unknown as MessageOutboxDispatcherService,
  );
  const job = {
    name: FEEDBACK_JOB_NAMES.dispatchOutboxV2,
    data: { schemaVersion: 2, correlationId: "test-outbox-poll" },
    opts: { repeat: { every: 1_000 } },
  } as Job;
  return { processor, queue, dispatcher, job };
}

describe("feedback outbox polling", () => {
  it("restores the persisted cadence and allows one batch job across replicas", async () => {
    const { processor, queue } = createProcessor();
    queue.getJobScheduler.mockResolvedValue({ every: 4_000 });
    await processor.onApplicationBootstrap();
    expect(queue.setGlobalConcurrency).toHaveBeenCalledWith(1);
    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      FEEDBACK_JOB_NAMES.dispatchOutboxV2,
      { every: 4_000 },
      expect.objectContaining({ name: FEEDBACK_JOB_NAMES.dispatchOutboxV2 }),
    );
  });

  it("processes at most 100 messages in small claim waves before accelerating", async () => {
    const { processor, queue, dispatcher, job } = createProcessor();
    dispatcher.dispatchBatch.mockResolvedValue({
      ...emptyBatch,
      claimedCount: 4,
    });
    await expect(processor.process(job)).resolves.toMatchObject({
      claimedCount: 100,
    });
    expect(dispatcher.dispatchBatch).toHaveBeenCalledTimes(25);
    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      FEEDBACK_JOB_NAMES.dispatchOutboxV2,
      { every: 500 },
      expect.any(Object),
    );
  });

  it("stops on a partial batch and slows polling", async () => {
    const { processor, queue, dispatcher, job } = createProcessor();
    dispatcher.dispatchBatch.mockResolvedValueOnce({
      ...emptyBatch,
      claimedCount: 1,
    });
    await expect(processor.process(job)).resolves.toMatchObject({
      claimedCount: 1,
    });
    expect(dispatcher.dispatchBatch).toHaveBeenCalledOnce();
    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      FEEDBACK_JOB_NAMES.dispatchOutboxV2,
      { every: 2_000 },
      expect.any(Object),
    );
  });

  it("does not immediately reclaim a deferred message in the same poll", async () => {
    const { processor, dispatcher, job } = createProcessor();
    dispatcher.dispatchBatch.mockResolvedValueOnce({
      ...emptyBatch,
      claimedCount: 4,
      items: [{ outboxId: "test-message", outcome: "deferred" }],
    });
    await processor.process(job);
    expect(dispatcher.dispatchBatch).toHaveBeenCalledOnce();
  });

  it("propagates a failed batch so the next scheduled poll recovers its rows", async () => {
    const { processor, queue, dispatcher, job } = createProcessor();
    const error = new Error("database unavailable");
    dispatcher.dispatchBatch.mockRejectedValueOnce(error);
    await expect(processor.process(job)).rejects.toBe(error);
    expect(queue.upsertJobScheduler).not.toHaveBeenCalled();
  });

  it("rejects an invalid job before touching the outbox", async () => {
    const { processor, dispatcher, job } = createProcessor();
    job.data = { schemaVersion: 1 };
    await expect(processor.process(job)).rejects.toThrow(
      "Invalid feedback outbox poll job",
    );
    expect(dispatcher.dispatchBatch).not.toHaveBeenCalled();
  });

  it.each([
    [1_000, 100, 500],
    [250, 100, 250],
    [1_000, 49, 2_000],
    [4_000, 0, 5_000],
    [5_000, 0, 5_000],
    [1_000, 50, 1_000],
    [1_000, 99, 1_000],
  ])("adapts %ims after %i claims to %ims", (current, claimed, expected) => {
    expect(nextOutboxPollInterval(current, claimed)).toBe(expected);
  });
});
