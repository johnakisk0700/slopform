import { InjectQueue } from "@nestjs/bullmq";
import { Injectable } from "@nestjs/common";
import type { Queue } from "bullmq";

import { REFERENCE_QUEUE } from "../../infrastructure/queue/queue.constants.js";
import {
  createReferenceInspectJobId,
  enqueueReferenceJobSchema,
  REFERENCE_JOB_NAMES,
  REFERENCE_JOB_SCHEMA_VERSION,
  referenceJobDataSchema,
  type EnqueueReferenceJobInput,
  type ReferenceJobData,
  type ReferenceJobName,
} from "./reference.schemas.js";
import { ReferenceService } from "./reference.service.js";

@Injectable()
export class ReferenceJobsService {
  constructor(
    @InjectQueue(REFERENCE_QUEUE)
    private readonly queue: Queue<ReferenceJobData, void, ReferenceJobName>,
    private readonly references: ReferenceService,
  ) {}

  async enqueue(
    input: EnqueueReferenceJobInput,
    correlationId: string,
  ): Promise<{ jobId: string }> {
    const validatedInput = enqueueReferenceJobSchema.parse(input);
    await this.references.get(validatedInput.recordId);

    const data = referenceJobDataSchema.parse({
      schemaVersion: REFERENCE_JOB_SCHEMA_VERSION,
      recordId: validatedInput.recordId,
      correlationId,
    });
    const jobId = createReferenceInspectJobId(
      validatedInput.recordId,
      validatedInput.idempotencyKey,
    );

    const job = await this.queue.add(
      REFERENCE_JOB_NAMES.inspectRecordV1,
      data,
      { jobId },
    );

    if (!job.id) {
      throw new Error("BullMQ returned a job without an id");
    }

    return { jobId: job.id };
  }
}
