import { InjectQueue } from "@nestjs/bullmq";
import { Injectable } from "@nestjs/common";
import type { Queue } from "bullmq";

import { REFERENCE_QUEUE } from "../../infrastructure/queue/queue.constants.js";
import {
  REFERENCE_JOB_NAMES,
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
    await this.references.get(input.recordId);

    const jobId = `reference-${input.idempotencyKey}`;
    const job = await this.queue.add(
      REFERENCE_JOB_NAMES.inspectRecord,
      { recordId: input.recordId, correlationId },
      { jobId },
    );

    if (!job.id) {
      throw new Error("BullMQ returned a job without an id");
    }

    return { jobId: job.id };
  }
}
