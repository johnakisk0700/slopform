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
} from "./outbox/deliver.service.js";
import { MessageOutboxRelayService } from "./outbox/relay.service.js";
import { PostEventFeedbackExtractionFallback } from "./extraction/fallback.service.js";
import {
  FeedbackExtractionGenerationError,
  isFeedbackProviderIncident,
  type FeedbackExtractionFailureCause,
} from "./extraction/model.service.js";
import {
  PostEventFeedbackCampaignNotFoundError,
  PostEventFeedbackConversationNotFoundError,
  PostEventFeedbackExtractor,
} from "./extraction/extract.service.js";
import {
  PostEventFeedbackIngressNotFoundError,
  PostEventFeedbackMaterializer,
} from "./ingress/materialize.service.js";
import {
  createFeedbackDeliverJobId,
  createFeedbackMaterializeJobId,
  createFeedbackSummarizeCampaignJobId,
  FEEDBACK_JOB_NAMES,
  feedbackDeliverJobDataSchema,
  feedbackExtractJobDataSchema,
  feedbackMaterializeJobDataSchema,
  feedbackRelayJobDataSchema,
  feedbackSummarizeCampaignJobDataSchema,
  feedbackSweepJobDataSchema,
  parseFeedbackSummarizeCampaignAttempt,
  type FeedbackJobData,
  type FeedbackJobName,
} from "./jobs.schemas.js";
import { PostEventFeedbackSweepService } from "./sweeps/sweep.service.js";
import {
  FeedbackSummaryGenerationError,
  PostEventFeedbackCampaignSummaryService,
} from "./summary/summary.service.js";

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
    private readonly summaries: PostEventFeedbackCampaignSummaryService,
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

      // Materialization moved to FEEDBACK_INGRESS_QUEUE on 2026-07-27 and no
      // producer targets this queue any more. The branch stays to drain what a
      // deploy caught mid-flight; deleting it would bury those jobs as
      // "unsupported" instead of finishing them. Safe to remove once no
      // `feedback.materialize.v1` has been seen on this queue for a retention
      // period.
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

      if (job.name === FEEDBACK_JOB_NAMES.summarizeCampaignV1) {
        const data = feedbackSummarizeCampaignJobDataSchema.parse(job.data);
        const attempt = parseFeedbackSummarizeCampaignAttempt(
          job.id ?? "",
          data.campaignId,
        );
        if (
          attempt === undefined ||
          job.id !==
            createFeedbackSummarizeCampaignJobId(data.campaignId, attempt)
        ) {
          throw new UnrecoverableError("Invalid feedback summarize job id");
        }

        try {
          await this.summaries.run(data, job.id);
        } catch (error) {
          const maxAttempts = job.opts.attempts ?? 1;
          const isLastAttempt = job.attemptsMade + 1 >= maxAttempts;
          if (
            isLastAttempt &&
            !(
              error instanceof FeedbackSummaryGenerationError &&
              !error.retryable
            )
          ) {
            // Permanent failures already marked the row inside `run`. A
            // retryable error that exhausted BullMQ still needs a durable
            // `failed` so the admin can re-request.
            await this.summaries.markTerminalFailure(
              data.campaignId,
              attempt,
              error instanceof FeedbackSummaryGenerationError
                ? error.detail || "generation_failed"
                : "exhausted_retries",
            );
          }
          throw error;
        }
        this.logger.log({
          event: "feedback.summarize_campaign.completed",
          jobId: job.id,
          correlationId: data.correlationId,
          campaignId: data.campaignId,
          attempt,
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
      if (
        error instanceof FeedbackSummaryGenerationError &&
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
   * conversation — but *why* decides what happens next, and the two answers are
   * opposites.
   *
   * A failure this conversation caused (a content filter, a schema nothing
   * satisfied, a refused proposal) gets the deterministic fallback: attention,
   * one ordinary note, one acknowledgement. Somebody has to read what the model
   * could not.
   *
   * A provider incident gets parked instead. It is one fault, shared by every
   * conversation in flight, and repeating the first treatment for each of them is
   * what turned thirty-six provider errors on 2026-07-27 into thirty-six rows
   * each demanding a human and thirty-six people told the analysis of their
   * evening had failed. Parking says nothing, asks for nobody, and queues the
   * next attempt.
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
    // The structural test, and the only place the two treatments diverge. It
    // reads the failure's own classification — never a message string — so a
    // provider that renames its errors cannot silently move a conversation from
    // one path to the other.
    const providerIncident = isFeedbackProviderIncident(error);
    try {
      if (providerIncident) {
        await this.fallback.park({
          conversationId: data.conversationId,
          correlationId: data.correlationId,
          cause,
        });
      } else {
        await this.fallback.apply({
          conversationId: data.conversationId,
          correlationId: data.correlationId,
          cause,
        });
      }
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

    // The detail rides in the message because that is what BullMQ keeps in
    // `failedReason`, which is where an operator looks first. `unknown` alone
    // sent the 2026-07-27 rehearsal into guesswork twice.
    const detail =
      error instanceof FeedbackExtractionGenerationError && error.failureDetail
        ? ` (${error.failureDetail})`
        : "";
    // «Parked» rather than «failed permanently», because the two are different
    // news and this is where an operator reads them. A parked job has a
    // successor already queued; calling that permanent would be the same
    // over-statement in `failedReason` that the inbox stopped making.
    //
    // Unrecoverable either way: this attempt must not be retried by BullMQ. For a
    // provider incident the ladder that matters is the parked retry, which is a
    // job of its own and outlives this one.
    return new UnrecoverableError(
      providerIncident
        ? `Feedback extraction parked on the provider: ${cause}${detail}`
        : `Feedback extraction failed permanently: ${cause}${detail}`,
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
function resolveExtractionFailureCause(
  error: unknown,
): FeedbackExtractionFailureCause {
  return error instanceof FeedbackExtractionGenerationError
    ? error.failureCause
    : "unknown";
}
