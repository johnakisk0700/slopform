import type { Job } from "bullmq";
import { UnrecoverableError } from "bullmq";
import { describe, expect, it, vi } from "vitest";

import {
  REFERENCE_JOB_NAMES,
  type ReferenceJobData,
  type ReferenceJobName,
} from "./reference.schemas.js";
import { ReferenceProcessor } from "./reference.processor.js";
import {
  ReferenceRecordNotFoundError,
  type ReferenceService,
} from "./reference.service.js";

const recordId = "7c57f3b8-2b13-48f5-8730-18ac71f490cd";

function createJob(
  data: unknown,
  name: string = REFERENCE_JOB_NAMES.inspectRecordV1,
): Job<ReferenceJobData, void, ReferenceJobName> {
  return {
    id: "job-1",
    name,
    data,
  } as unknown as Job<ReferenceJobData, void, ReferenceJobName>;
}

describe("ReferenceProcessor", () => {
  it("does not retry a payload that cannot become valid", async () => {
    const references = { get: vi.fn() } as unknown as ReferenceService;
    const processor = new ReferenceProcessor(references);

    await expect(processor.process(createJob({}))).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    expect(references.get).not.toHaveBeenCalled();
  });

  it("does not retry a job whose authoritative record is gone", async () => {
    const references = {
      get: vi
        .fn()
        .mockRejectedValue(new ReferenceRecordNotFoundError(recordId)),
    } as unknown as ReferenceService;
    const processor = new ReferenceProcessor(references);

    await expect(
      processor.process(
        createJob({
          schemaVersion: 1,
          recordId,
          correlationId: "correlation-1",
        }),
      ),
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it("preserves transient failures for configured retries", async () => {
    const transientFailure = new Error("database temporarily unavailable");
    const references = {
      get: vi.fn().mockRejectedValue(transientFailure),
    } as unknown as ReferenceService;
    const processor = new ReferenceProcessor(references);

    await expect(
      processor.process(
        createJob({
          schemaVersion: 1,
          recordId,
          correlationId: "correlation-1",
        }),
      ),
    ).rejects.toBe(transientFailure);
  });

  it("does not retry unsupported job names", async () => {
    const references = { get: vi.fn() } as unknown as ReferenceService;
    const processor = new ReferenceProcessor(references);

    await expect(
      processor.process(
        createJob(
          {
            schemaVersion: 1,
            recordId,
            correlationId: "correlation-1",
          },
          "reference.unknown",
        ),
      ),
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it("rejects an unsupported payload version without reading domain state", async () => {
    const references = { get: vi.fn() } as unknown as ReferenceService;
    const processor = new ReferenceProcessor(references);

    await expect(
      processor.process(
        createJob({
          schemaVersion: 2,
          recordId,
          correlationId: "correlation-1",
        }),
      ),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect(references.get).not.toHaveBeenCalled();
  });
});
