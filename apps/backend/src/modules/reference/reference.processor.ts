import { OnWorkerEvent, Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import type { Job } from "bullmq";

import {
  REFERENCE_JOB_NAMES,
  REFERENCE_QUEUE,
  type ReferenceJobName,
} from "../../infrastructure/queue/queue.constants.js";
import {
  referenceJobDataSchema,
  type ReferenceJobData,
} from "./reference.schemas.js";
import { ReferenceService } from "./reference.service.js";

@Processor(REFERENCE_QUEUE, { concurrency: 5 })
export class ReferenceProcessor extends WorkerHost {
  private readonly logger = new Logger(ReferenceProcessor.name);

  constructor(private readonly references: ReferenceService) {
    super();
  }

  async process(
    job: Job<ReferenceJobData, void, ReferenceJobName>,
  ): Promise<void> {
    switch (job.name) {
      case REFERENCE_JOB_NAMES.inspectRecord: {
        const data = referenceJobDataSchema.parse(job.data);
        const record = await this.references.get(data.recordId);
        this.logger.log({
          event: "reference_record.inspected",
          jobId: job.id,
          correlationId: data.correlationId,
          referenceRecordId: record.id,
        });
        return;
      }
      default: {
        const unsupportedName: never = job.name;
        throw new Error(
          `Unsupported reference job: ${String(unsupportedName)}`,
        );
      }
    }
  }

  @OnWorkerEvent("failed")
  onFailed(job: Job | undefined, error: Error): void {
    this.logger.error({
      event: "job.failed",
      jobId: job?.id,
      jobName: job?.name,
      error,
    });
  }
}
