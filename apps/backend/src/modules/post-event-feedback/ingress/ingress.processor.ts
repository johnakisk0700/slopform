import { OnWorkerEvent, Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import { MetricsTime, UnrecoverableError, type Job } from "bullmq";
import { ZodError } from "zod";

import {
  FEEDBACK_INGRESS_QUEUE,
  QUEUE_WORKER_CONFIG,
} from "../../../infrastructure/queue/queue.constants.js";
import { ConversationPersistenceError } from "../../conversations/conversation-persistence.errors.js";
import {
  createFeedbackMaterializeJobId,
  FEEDBACK_JOB_NAMES,
  feedbackMaterializeJobDataSchema,
  type FeedbackJobData,
  type FeedbackJobName,
} from "../jobs.schemas.js";
import { PostEventFeedbackIngressNotFoundError } from "./materialize.service.js";
import { PostEventFeedbackMaterializationCoordinator } from "./materialization-coordinator.service.js";

/**
 * Per-process materialize concurrency.
 *
 * The deployment-wide materialization coordinator now serializes one routing
 * identity, so this worker can serve unrelated conversations concurrently.
 * Twenty lets BullMQ accept a burst without involving the provider budget.
 * Materialization itself holds at most five session locks from a separate pool;
 * its repository work keeps the normal worker pool. Same-route jobs first queue
 * behind one local promise, so a hot participant consumes one lock slot.
 */
export const FEEDBACK_INGRESS_WORKER_CONCURRENCY = 20;

/**
 * The transcript writer, deliberately on its own queue.
 *
 * Everything the feedback loop assumes rests on inbound messages being in the
 * transcript quickly: the quiet window collects what is already written, the
 * staleness guards compare against it, and the admin renders it in timestamp
 * order. While materialization shared a queue with extraction it inherited
 * extraction's service time — a slot held for the length of a model call — and
 * none of those three held.
 *
 * Separating the queues is the whole fix. This worker never calls a provider,
 * so nothing here can hold a slot for tens of seconds.
 */
@Processor(
  { name: FEEDBACK_INGRESS_QUEUE, configKey: QUEUE_WORKER_CONFIG },
  {
    concurrency: FEEDBACK_INGRESS_WORKER_CONCURRENCY,
    maxStalledCount: 1,
    metrics: { maxDataPoints: MetricsTime.ONE_WEEK * 2 },
    name: "feedback-ingress-worker",
  },
)
export class PostEventFeedbackIngressProcessor extends WorkerHost {
  private readonly logger = new Logger(PostEventFeedbackIngressProcessor.name);

  constructor(
    private readonly materializer: PostEventFeedbackMaterializationCoordinator,
  ) {
    super();
  }

  async process(
    job: Job<FeedbackJobData, void, FeedbackJobName>,
  ): Promise<void> {
    try {
      if (job.name !== FEEDBACK_JOB_NAMES.materializeV1) {
        throw new UnrecoverableError(
          `Unsupported feedback ingress job: ${String(job.name)}`,
        );
      }

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
      queue: FEEDBACK_INGRESS_QUEUE,
      jobId: job?.id,
      jobName: job?.name,
      previous,
      attempts,
      attemptsMade,
      willRetry:
        !!job &&
        !(error instanceof UnrecoverableError) &&
        attemptsMade < attempts,
      error: {
        name: error.name,
        // Only for the errors this processor constructs itself. Any other
        // error's message may quote whatever it was handed, and job data is
        // never log-safe by assumption.
        ...(error instanceof UnrecoverableError
          ? { message: error.message.slice(0, 300) }
          : {}),
      },
    });
  }

  @OnWorkerEvent("stalled")
  onStalled(jobId: string, previous: string): void {
    this.logger.warn({
      event: "queue.job.stalled",
      queue: FEEDBACK_INGRESS_QUEUE,
      jobId,
      previous,
    });
  }

  @OnWorkerEvent("lockRenewalFailed")
  onLockRenewalFailed(jobIds: string[]): void {
    this.logger.error({
      event: "queue.worker.lock_renewal_failed",
      queue: FEEDBACK_INGRESS_QUEUE,
      jobIds,
    });
  }

  @OnWorkerEvent("error")
  onError(error: Error): void {
    this.logger.error({
      event: "queue.worker.error",
      queue: FEEDBACK_INGRESS_QUEUE,
      error: { name: error.name },
    });
  }
}
