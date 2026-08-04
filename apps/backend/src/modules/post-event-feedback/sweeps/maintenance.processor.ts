import { OnWorkerEvent, Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import { MetricsTime, UnrecoverableError, type Job } from "bullmq";
import { ZodError } from "zod";

import {
  FEEDBACK_MAINTENANCE_QUEUE,
  QUEUE_WORKER_CONFIG,
} from "../../../infrastructure/queue/queue.constants.js";
import {
  FEEDBACK_JOB_NAMES,
  feedbackMaintenanceJobDataSchema,
  type FeedbackJobData,
  type FeedbackJobName,
} from "../jobs.schemas.js";
import { PostEventFeedbackMaintenanceService } from "./maintenance.service.js";

@Processor(
  { name: FEEDBACK_MAINTENANCE_QUEUE, configKey: QUEUE_WORKER_CONFIG },
  {
    concurrency: 1,
    maxStalledCount: 1,
    metrics: { maxDataPoints: MetricsTime.ONE_WEEK * 2 },
    name: "feedback-maintenance-worker",
  },
)
export class PostEventFeedbackMaintenanceProcessor extends WorkerHost {
  private readonly logger = new Logger(
    PostEventFeedbackMaintenanceProcessor.name,
  );

  constructor(
    private readonly maintenance: PostEventFeedbackMaintenanceService,
  ) {
    super();
  }

  async process(
    job: Job<FeedbackJobData, void, FeedbackJobName>,
  ): Promise<void> {
    try {
      if (job.name !== FEEDBACK_JOB_NAMES.maintenanceV2) {
        throw new UnrecoverableError(
          `Unsupported feedback maintenance job: ${String(job.name)}`,
        );
      }
      const data = feedbackMaintenanceJobDataSchema.parse(job.data);
      const result = await this.maintenance.run(data.correlationId);
      this.logger.log({
        event: "feedback.maintenance.completed",
        queue: FEEDBACK_MAINTENANCE_QUEUE,
        jobId: job.id,
        correlationId: data.correlationId,
        completed: result.completed,
      });
    } catch (error) {
      if (error instanceof ZodError) {
        throw new UnrecoverableError("Invalid feedback maintenance payload");
      }
      throw error;
    }
  }

  @OnWorkerEvent("failed")
  onFailed(job: Job | undefined, error: Error, previous: string): void {
    this.logger.error({
      event: "queue.job.failed",
      queue: FEEDBACK_MAINTENANCE_QUEUE,
      jobId: job?.id,
      jobName: job?.name,
      previous,
      error: { name: error.name },
    });
  }
}
