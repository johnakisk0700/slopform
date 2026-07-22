import { OnWorkerEvent, Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import { MetricsTime, UnrecoverableError, type Job } from "bullmq";
import { ZodError } from "zod";

import {
  QUEUE_WORKER_CONFIG,
  REFERENCE_QUEUE,
} from "../../infrastructure/queue/queue.constants.js";
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

@Processor(
  { name: REFERENCE_QUEUE, configKey: QUEUE_WORKER_CONFIG },
  {
    concurrency: 5,
    maxStalledCount: 1,
    metrics: { maxDataPoints: MetricsTime.ONE_WEEK * 2 },
    name: "reference-worker",
  },
)
export class ReferenceProcessor extends WorkerHost {
  private readonly logger = new Logger(ReferenceProcessor.name);

  constructor(private readonly references: ReferenceService) {
    super();
  }

  async process(
    job: Job<ReferenceJobData, void, ReferenceJobName>,
  ): Promise<void> {
    switch (job.name) {
      case REFERENCE_JOB_NAMES.inspectRecordV1: {
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
  onFailed(job: Job | undefined, error: Error, previous: string): void {
    const attempts = job?.opts.attempts ?? 1;
    const attemptsMade = job?.attemptsMade ?? 0;
    const parsedData = referenceJobDataSchema.safeParse(job?.data);

    this.logger.error({
      event: "queue.job.failed",
      queue: REFERENCE_QUEUE,
      jobId: job?.id,
      jobName: job?.name,
      previous,
      attempts,
      attemptsMade,
      willRetry:
        !!job &&
        !(error instanceof UnrecoverableError) &&
        attemptsMade < attempts,
      ...(parsedData.success
        ? { correlationId: parsedData.data.correlationId }
        : {}),
      error: serializeError(error),
    });
  }

  @OnWorkerEvent("stalled")
  onStalled(jobId: string, previous: string): void {
    this.logger.warn({
      event: "queue.job.stalled",
      queue: REFERENCE_QUEUE,
      jobId,
      previous,
    });
  }

  @OnWorkerEvent("lockRenewalFailed")
  onLockRenewalFailed(jobIds: string[]): void {
    this.logger.error({
      event: "queue.worker.lock_renewal_failed",
      queue: REFERENCE_QUEUE,
      jobIds,
    });
  }

  @OnWorkerEvent("error")
  onError(error: Error): void {
    this.logger.error({
      event: "queue.worker.error",
      queue: REFERENCE_QUEUE,
      error: serializeError(error),
    });
  }
}

function serializeError(error: Error): {
  readonly message: string;
  readonly name: string;
  readonly stack?: string;
} {
  return {
    name: error.name,
    message: error.message,
    ...(error.stack ? { stack: error.stack } : {}),
  };
}
