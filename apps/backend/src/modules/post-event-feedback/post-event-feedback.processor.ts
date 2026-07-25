import { OnWorkerEvent, Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import { MetricsTime, UnrecoverableError, type Job } from "bullmq";
import { ZodError } from "zod";

import {
  FEEDBACK_QUEUE,
  QUEUE_WORKER_CONFIG,
} from "../../infrastructure/queue/queue.constants.js";
import { ConversationPersistenceError } from "../conversations/conversation-persistence.errors.js";
import {
  PostEventFeedbackIngressNotFoundError,
  PostEventFeedbackMaterializer,
} from "./post-event-feedback-materializer.service.js";
import {
  createFeedbackMaterializeJobId,
  FEEDBACK_JOB_NAMES,
  feedbackExtractJobDataSchema,
  feedbackMaterializeJobDataSchema,
  type FeedbackJobData,
  type FeedbackJobName,
} from "./post-event-feedback.schemas.js";

@Processor(
  { name: FEEDBACK_QUEUE, configKey: QUEUE_WORKER_CONFIG },
  {
    // One message at a time keeps a participant's burst in arrival order inside
    // the transcript without a per-conversation lock. A campaign is tens of
    // conversations, not a firehose; raise this only together with explicit
    // per-conversation serialization.
    concurrency: 1,
    maxStalledCount: 1,
    metrics: { maxDataPoints: MetricsTime.ONE_WEEK * 2 },
    name: "feedback-worker",
  },
)
export class PostEventFeedbackProcessor extends WorkerHost {
  private readonly logger = new Logger(PostEventFeedbackProcessor.name);

  constructor(private readonly materializer: PostEventFeedbackMaterializer) {
    super();
  }

  async process(
    job: Job<FeedbackJobData, void, FeedbackJobName>,
  ): Promise<void> {
    try {
      if (job.name === FEEDBACK_JOB_NAMES.materializeV1) {
        const data = feedbackMaterializeJobDataSchema.parse(job.data);
        if (job.id !== createFeedbackMaterializeJobId(data.ingressId)) {
          throw new UnrecoverableError("Invalid feedback materialize job id");
        }

        const result = await this.materializer.materialize(data);
        this.logger.log({
          event: "feedback.materialize.completed",
          jobId: job.id,
          correlationId: data.correlationId,
          ingressId: data.ingressId,
          outcome: result.outcome,
          ...(result.conversationId
            ? { conversationId: result.conversationId }
            : {}),
          ...(result.extractJobId ? { extractJobId: result.extractJobId } : {}),
        });
        return;
      }

      if (job.name === FEEDBACK_JOB_NAMES.extractV1) {
        // WP5 owns extraction. The contract is already fixed so materialization
        // can enqueue it today; until that processor lands the job is only
        // recorded. Replace this branch with the real consumer — do not change
        // the job name or payload.
        const data = feedbackExtractJobDataSchema.parse(job.data);
        this.logger.log({
          event: "feedback.extract.not_implemented",
          jobId: job.id,
          correlationId: data.correlationId,
          conversationId: data.conversationId,
        });
        return;
      }

      throw new UnrecoverableError(
        `Unsupported feedback job: ${String(job.name)}`,
      );
    } catch (error) {
      if (error instanceof ZodError) {
        throw new UnrecoverableError("Invalid feedback job payload");
      }
      if (error instanceof PostEventFeedbackIngressNotFoundError) {
        throw new UnrecoverableError(error.message);
      }
      // A rejected replay or an impossible transition is a data fault, not a
      // dependency outage; retrying it would only repeat the same rejection.
      if (error instanceof ConversationPersistenceError) {
        throw new UnrecoverableError(error.message);
      }
      throw error;
    }
  }

  @OnWorkerEvent("failed")
  onFailed(job: Job | undefined, error: Error, previous: string): void {
    const attempts = job?.opts.attempts ?? 1;
    const attemptsMade = job?.attemptsMade ?? 0;

    this.logger.error({
      event: "queue.job.failed",
      queue: FEEDBACK_QUEUE,
      jobId: job?.id,
      jobName: job?.name,
      previous,
      attempts,
      attemptsMade,
      willRetry:
        !!job &&
        !(error instanceof UnrecoverableError) &&
        attemptsMade < attempts,
      error: { name: error.name },
    });
  }

  @OnWorkerEvent("stalled")
  onStalled(jobId: string, previous: string): void {
    this.logger.warn({
      event: "queue.job.stalled",
      queue: FEEDBACK_QUEUE,
      jobId,
      previous,
    });
  }

  @OnWorkerEvent("lockRenewalFailed")
  onLockRenewalFailed(jobIds: string[]): void {
    this.logger.error({
      event: "queue.worker.lock_renewal_failed",
      queue: FEEDBACK_QUEUE,
      jobIds,
    });
  }

  @OnWorkerEvent("error")
  onError(error: Error): void {
    this.logger.error({
      event: "queue.worker.error",
      queue: FEEDBACK_QUEUE,
      error: { name: error.name },
    });
  }
}
