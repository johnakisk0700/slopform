import type { Queue } from "bullmq";
import { describe, expect, it, vi } from "vitest";

import { ReferenceJobsService } from "./reference-jobs.service.js";
import {
  createReferenceInspectJobId,
  REFERENCE_JOB_NAMES,
  type ReferenceJobData,
  type ReferenceJobName,
} from "./reference.schemas.js";
import type { ReferenceService } from "./reference.service.js";

const recordId = "7c57f3b8-2b13-48f5-8730-18ac71f490cd";
const idempotencyKey = "1df55f1f-72d0-454a-a7c4-c1a13494dd01";

describe("ReferenceJobsService", () => {
  it("adds a versioned job with a deterministic record-scoped id", async () => {
    const jobId = createReferenceInspectJobId(recordId, idempotencyKey);
    const queue = {
      add: vi.fn().mockResolvedValue({ id: jobId }),
    } as unknown as Queue<ReferenceJobData, void, ReferenceJobName>;
    const references = {
      get: vi.fn().mockResolvedValue({ id: recordId }),
    } as unknown as ReferenceService;
    const jobs = new ReferenceJobsService(queue, references);

    await expect(
      jobs.enqueue({ recordId, idempotencyKey }, "correlation-1"),
    ).resolves.toEqual({ jobId });
    expect(references.get).toHaveBeenCalledWith(recordId);
    expect(queue.add).toHaveBeenCalledWith(
      REFERENCE_JOB_NAMES.inspectRecordV1,
      {
        schemaVersion: 1,
        recordId,
        correlationId: "correlation-1",
      },
      { jobId },
    );
    expect(jobId).not.toContain(":");
  });

  it("does not enqueue when the authoritative record lookup fails", async () => {
    const failure = new Error("missing record");
    const queue = { add: vi.fn() } as unknown as Queue<
      ReferenceJobData,
      void,
      ReferenceJobName
    >;
    const references = {
      get: vi.fn().mockRejectedValue(failure),
    } as unknown as ReferenceService;
    const jobs = new ReferenceJobsService(queue, references);

    await expect(
      jobs.enqueue({ recordId, idempotencyKey }, "correlation-1"),
    ).rejects.toBe(failure);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it("rejects an invalid correlation id before writing to Redis", async () => {
    const queue = { add: vi.fn() } as unknown as Queue<
      ReferenceJobData,
      void,
      ReferenceJobName
    >;
    const references = {
      get: vi.fn().mockResolvedValue({ id: recordId }),
    } as unknown as ReferenceService;
    const jobs = new ReferenceJobsService(queue, references);

    await expect(
      jobs.enqueue({ recordId, idempotencyKey }, ""),
    ).rejects.toThrow();
    expect(queue.add).not.toHaveBeenCalled();
  });
});
