import { OnWorkerEvent, Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import {
  DelayedError,
  MetricsTime,
  UnrecoverableError,
  type Job,
} from "bullmq";
import { ZodError } from "zod";

import {
  FEEDBACK_SUMMARY_QUEUE,
  QUEUE_WORKER_CONFIG,
} from "../../../infrastructure/queue/queue.constants.js";
import {
  createFeedbackSummarizeCampaignV2JobId,
  FEEDBACK_JOB_NAMES,
  feedbackSummarizeCampaignV2JobDataSchema,
  type FeedbackJobData,
  type FeedbackJobName,
} from "../jobs.schemas.js";
import {
  FeedbackSummaryGenerationError,
  PostEventFeedbackCampaignSummaryService,
} from "./summary.service.js";

export const FEEDBACK_SUMMARY_WORKER_CONCURRENCY = 1;
export const FEEDBACK_SUMMARY_CLAIM_BUSY_RETRY_MS = 15_000;

@Processor(
  { name: FEEDBACK_SUMMARY_QUEUE, configKey: QUEUE_WORKER_CONFIG },
  {
    concurrency: FEEDBACK_SUMMARY_WORKER_CONCURRENCY,
    maxStalledCount: 1,
    metrics: { maxDataPoints: MetricsTime.ONE_WEEK * 2 },
    name: "feedback-summary-worker",
  },
)
export class PostEventFeedbackSummaryProcessor extends WorkerHost {
  private readonly logger = new Logger(PostEventFeedbackSummaryProcessor.name);

  constructor(
    private readonly summaries: PostEventFeedbackCampaignSummaryService,
  ) {
    super();
  }

  async process(
    job: Job<FeedbackJobData, void, FeedbackJobName>,
  ): Promise<void> {
    try {
      if (job.name !== FEEDBACK_JOB_NAMES.summarizeCampaignV2) {
        throw new UnrecoverableError(
          `Unsupported feedback summary job: ${String(job.name)}`,
        );
      }
      const data = feedbackSummarizeCampaignV2JobDataSchema.parse(job.data);
      if (
        job.id !==
        createFeedbackSummarizeCampaignV2JobId(data.campaignId, data.attempt)
      ) {
        throw new UnrecoverableError("Invalid feedback summary job id");
      }

      const outcome = await this.summaries.run(data, {
        terminalOnFailure: job.attemptsMade + 1 >= (job.opts.attempts ?? 1),
      });
      if (outcome === "claim_busy") {
        // A BullMQ stall or duplicate wake-up does not get to buy a second
        // summary. Keep this deterministic wake-up nonterminal until the
        // PostgreSQL owner finishes or its lease expires.
        await job.moveToDelayed(
          Date.now() + FEEDBACK_SUMMARY_CLAIM_BUSY_RETRY_MS,
          job.token,
        );
        throw new DelayedError();
      }

      this.logger.log({
        event: "feedback.summarize_campaign.completed",
        queue: FEEDBACK_SUMMARY_QUEUE,
        jobId: job.id,
        correlationId: data.correlationId,
        campaignId: data.campaignId,
        attempt: data.attempt,
        outcome,
      });
    } catch (error) {
      if (error instanceof ZodError) {
        throw new UnrecoverableError("Invalid feedback summary job payload");
      }
      if (error instanceof FeedbackSummaryGenerationError && !error.retryable) {
        throw new UnrecoverableError(error.message);
      }
      throw error;
    }
  }

  @OnWorkerEvent("failed")
  onFailed(job: Job | undefined, error: Error, previous: string): void {
    this.logger.error({
      event: "queue.job.failed",
      queue: FEEDBACK_SUMMARY_QUEUE,
      jobId: job?.id,
      jobName: job?.name,
      previous,
      attempts: job?.opts.attempts ?? 1,
      attemptsMade: job?.attemptsMade ?? 0,
      willRetry:
        !!job &&
        !(error instanceof UnrecoverableError) &&
        (job.attemptsMade ?? 0) < (job.opts.attempts ?? 1),
      error: { name: error.name },
    });
  }

  @OnWorkerEvent("stalled")
  onStalled(jobId: string, previous: string): void {
    this.logger.warn({
      event: "queue.job.stalled",
      queue: FEEDBACK_SUMMARY_QUEUE,
      jobId,
      previous,
    });
  }
}
