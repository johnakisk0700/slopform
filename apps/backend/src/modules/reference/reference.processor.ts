import { OnWorkerEvent, Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import { UnrecoverableError, type Job } from "bullmq";
import { ZodError } from "zod";

import { REFERENCE_QUEUE } from "../../infrastructure/queue/queue.constants.js";
import {
  REFERENCE_JOB_NAMES,
  referenceJobDataSchema,
  type ReferenceJobData,
  type ReferenceJobName,
} from "./reference.schemas.js";
import {
  ReferenceRecordNotFoundError,
  ReferenceService,
} from "./reference.service.js";

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
        try {
          const data = referenceJobDataSchema.parse(job.data);
          const record = await this.references.get(data.recordId);

          this.logger.log({
            event: "reference_record.inspected",
            jobId: job.id,
            correlationId: data.correlationId,
            referenceRecordId: record.id,
          });
          return;
        } catch (error) {
          if (error instanceof ZodError) {
            throw new UnrecoverableError("Invalid reference job payload");
          }

          if (error instanceof ReferenceRecordNotFoundError) {
            throw new UnrecoverableError(error.message);
          }

          throw error;
        }
      }
      default: {
        throw new UnrecoverableError(
          `Unsupported reference job: ${String(job.name)}`,
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
