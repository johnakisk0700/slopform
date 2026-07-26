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
  MessageOutboxDeliveryService,
  MessageOutboxNotFoundError,
} from "./message-outbox-delivery.service.js";
import { MessageOutboxRelayService } from "./message-outbox-relay.service.js";
import { PostEventFeedbackExtractionFallback } from "./post-event-feedback-extraction-fallback.service.js";
import {
  FeedbackExtractionGenerationError,
  type FeedbackExtractionFailureCause,
} from "./post-event-feedback-extraction.service.js";
import {
  PostEventFeedbackCampaignNotFoundError,
  PostEventFeedbackConversationNotFoundError,
  PostEventFeedbackExtractor,
} from "./post-event-feedback-extractor.service.js";
import {
  PostEventFeedbackIngressNotFoundError,
  PostEventFeedbackMaterializer,
} from "./post-event-feedback-materializer.service.js";
import {
  createFeedbackDeliverJobId,
  createFeedbackMaterializeJobId,
  FEEDBACK_JOB_NAMES,
  feedbackDeliverJobDataSchema,
  feedbackExtractJobDataSchema,
  feedbackMaterializeJobDataSchema,
  feedbackRelayJobDataSchema,
  feedbackSweepJobDataSchema,
  type FeedbackJobData,
  type FeedbackJobName,
} from "./post-event-feedback.schemas.js";
import { PostEventFeedbackSweepService } from "./post-event-feedback-sweep.service.js";

/**
 * Actual per-process feedback job concurrency.
 *
 * This is an application ordering limit, not an OpenRouter quota. OpenRouter
 * publishes no fixed concurrency cap for paid models; upstream capacity is
 * dynamic and surfaces as retryable 429/503 responses. One extraction job can
 * already make two provider calls in parallel (extraction + attention).
 *
 * Keep this at one until jobs for the same conversation are serialized and
 * provider-call limiting is separated from transcript/outbox ordering. Worker
 * replicas multiply this value.
 *
 * Verified 2026-07-26:
 * https://openrouter.ai/docs/api_reference/limits
 */
export const FEEDBACK_WORKER_CONCURRENCY = 1;

@Processor(
  { name: FEEDBACK_QUEUE, configKey: QUEUE_WORKER_CONFIG },
  {
    // One message at a time keeps a participant's burst in arrival order inside
    // the transcript without a per-conversation lock. A campaign is tens of
    // conversations, not a firehose; raise this only together with explicit
    // per-conversation serialization. Outbox delivery also shares this worker,
    // so session pacing remains single-threaded here.
    concurrency: FEEDBACK_WORKER_CONCURRENCY,
    maxStalledCount: 1,
    metrics: { maxDataPoints: MetricsTime.ONE_WEEK * 2 },
    name: "feedback-worker",
  },
)
export class PostEventFeedbackProcessor extends WorkerHost {
  private readonly logger = new Logger(PostEventFeedbackProcessor.name);

  constructor(
    private readonly materializer: PostEventFeedbackMaterializer,
    private readonly relay: MessageOutboxRelayService,
    private readonly delivery: MessageOutboxDeliveryService,
    private readonly extractor: PostEventFeedbackExtractor,
    private readonly sweeps: PostEventFeedbackSweepService,
    private readonly fallback: PostEventFeedbackExtractionFallback,
  ) {
    super();
  }

  async process(
    job: Job<FeedbackJobData, void, FeedbackJobName>,
  ): Promise<void> {
    try {
      if (job.name === FEEDBACK_JOB_NAMES.relayOutboxV1) {
        feedbackRelayJobDataSchema.parse(job.data);
        await this.relay.relay();
        return;
      }

      if (job.name === FEEDBACK_JOB_NAMES.sweepRemindersV1) {
        const data = feedbackSweepJobDataSchema.parse(job.data);
        await this.sweeps.sweepReminders(data.correlationId);
        return;
      }

      if (job.name === FEEDBACK_JOB_NAMES.sweepExpiryV1) {
        const data = feedbackSweepJobDataSchema.parse(job.data);
        await this.sweeps.sweepExpiry(data.correlationId);
        return;
      }

      if (job.name === FEEDBACK_JOB_NAMES.sweepIngressV1) {
        const data = feedbackSweepJobDataSchema.parse(job.data);
        await this.sweeps.sweepIngress(data.correlationId);
        return;
      }

      if (job.name === FEEDBACK_JOB_NAMES.deliverV1) {
        const data = feedbackDeliverJobDataSchema.parse(job.data);
        if (job.id !== createFeedbackDeliverJobId(data.outboxId)) {
          throw new UnrecoverableError("Invalid feedback deliver job id");
        }

        const result = await this.delivery.deliver(
          data.outboxId,
          data.correlationId,
        );
        this.logger.log({
          event: "feedback.deliver.completed",
          jobId: job.id,
          correlationId: data.correlationId,
          outboxId: data.outboxId,
          outcome: result.outcome,
        });
        return;
      }

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
        const data = feedbackExtractJobDataSchema.parse(job.data);
        let result;
        try {
          result = await this.extractor.extract(data);
        } catch (error) {
          const terminal = await this.applyExtractionFallback(job, data, error);
          throw terminal ?? error;
        }
        this.logger.log({
          event: "feedback.extract.completed",
          jobId: job.id,
          correlationId: data.correlationId,
          conversationId: data.conversationId,
          outcome: result.outcome,
          cursorSeq: result.cursorSeq,
          answersWritten: result.answersWritten,
          notesWritten: result.notesWritten,
          ...(result.outboxId ? { outboxId: result.outboxId } : {}),
          ...(result.model ? { model: result.model } : {}),
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
      if (
        error instanceof PostEventFeedbackIngressNotFoundError ||
        error instanceof PostEventFeedbackConversationNotFoundError ||
        error instanceof PostEventFeedbackCampaignNotFoundError
      ) {
        throw new UnrecoverableError(error.message);
      }
      // A missing provider key or a rejected request repeats identically on a
      // retry; a timeout, a rate limit or a provider 5xx does not.
      if (
        error instanceof FeedbackExtractionGenerationError &&
        !error.retryable
      ) {
        throw new UnrecoverableError(error.message);
      }
      if (error instanceof MessageOutboxNotFoundError) {
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

  /**
   * The last thing a dying extraction run does.
   *
   * A run is terminal when the provider rejected it permanently or when BullMQ
   * has no attempt left. Either way the model will not speak for this
   * conversation, so the deterministic fallback records what it can — attention,
   * one ordinary note, one acknowledgement — before the job is buried.
   *
   * Returns the error to throw. It is an `UnrecoverableError` whose message
   * carries the bounded cause class, so the class an operator needs is visible
   * in the queue's `failedReason` and not only in the audit table.
   */
  private async applyExtractionFallback(
    job: Job<FeedbackJobData, void, FeedbackJobName>,
    data: { readonly conversationId: string; readonly correlationId: string },
    error: unknown,
  ): Promise<UnrecoverableError | undefined> {
    // Nothing exists to attach a note to, and both are already permanent
    // faults handled by the outer classifier.
    if (
      error instanceof PostEventFeedbackConversationNotFoundError ||
      error instanceof PostEventFeedbackCampaignNotFoundError
    ) {
      return undefined;
    }

    const permanent =
      error instanceof FeedbackExtractionGenerationError && !error.retryable;
    // Mirrors the assistant worker's exhaustion test, deliberately: one
    // convention for "this was the last attempt" across both queues.
    const exhausted = (job.attemptsMade ?? 0) + 1 >= (job.opts?.attempts ?? 1);
    if (!permanent && !exhausted) {
      return undefined;
    }

    const cause = resolveExtractionFailureCause(error);
    try {
      await this.fallback.apply({
        conversationId: data.conversationId,
        correlationId: data.correlationId,
        cause,
      });
    } catch (fallbackError) {
      // The run is already lost; a failing fallback must not replace the
      // original diagnosis with its own.
      this.logger.error({
        event: "feedback.extract.fallback_failed",
        jobId: job.id,
        correlationId: data.correlationId,
        conversationId: data.conversationId,
        cause,
        error: {
          name:
            fallbackError instanceof Error
              ? fallbackError.name
              : "UnknownError",
        },
      });
    }

    return new UnrecoverableError(
      `Feedback extraction failed permanently: ${cause}`,
    );
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

/**
 * Anything that is not a classified generation failure is `unknown` on purpose.
 * The cause class is an operator-facing summary, not an error taxonomy: it must
 * stay small enough to act on, so a persistence fault and a bug both land in
 * the bucket that means "read the logs".
 */
export function resolveExtractionFailureCause(
  error: unknown,
): FeedbackExtractionFailureCause {
  return error instanceof FeedbackExtractionGenerationError
    ? error.failureCause
    : "unknown";
}
