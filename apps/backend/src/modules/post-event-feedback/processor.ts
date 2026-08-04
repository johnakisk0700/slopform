import { OnWorkerEvent, Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import { MetricsTime, UnrecoverableError, type Job } from "bullmq";
import { ZodError } from "zod";

import {
  FEEDBACK_QUEUE,
  QUEUE_WORKER_CONFIG,
} from "../../infrastructure/queue/queue.constants.js";
import { ConversationPersistenceError } from "../conversations/conversation-persistence.errors.js";
import { PostEventFeedbackIngressNotFoundError } from "./ingress/materialize.service.js";
import { PostEventFeedbackMaterializationCoordinator } from "./ingress/materialization-coordinator.service.js";
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
import { PostEventFeedbackCampaignSummaryService } from "./summary/summary.service.js";
import { createFeedbackWorkerRegistrationNameFromEnvironment } from "./worker-attestation.js";
import { FeedbackConversationWakeupService } from "./reconciliation/wakeup.service.js";

/**
 * Actual per-process feedback job concurrency.
 *
 * This is a rollout-drain ordering limit, not a provider quota. Retained V1
 * extraction and summary jobs are converted into durable V2 wake-ups before
 * any model entry; the dedicated V2 processors own execution concurrency.
 */
export const FEEDBACK_WORKER_CONCURRENCY = 10;
export const FEEDBACK_WORKER_REGISTRATION_NAME =
  createFeedbackWorkerRegistrationNameFromEnvironment(process.env);

@Processor(
  { name: FEEDBACK_QUEUE, configKey: QUEUE_WORKER_CONFIG },
  {
    // All retained V1 jobs are validation/conversion bridges. Outbox delivery
    // is owned exclusively by the direct PostgreSQL dispatcher.
    concurrency: FEEDBACK_WORKER_CONCURRENCY,
    maxStalledCount: 1,
    metrics: { maxDataPoints: MetricsTime.ONE_WEEK * 2 },
    name: FEEDBACK_WORKER_REGISTRATION_NAME,
  },
)
export class PostEventFeedbackProcessor extends WorkerHost {
  private readonly logger = new Logger(PostEventFeedbackProcessor.name);

  constructor(
    private readonly materializer: PostEventFeedbackMaterializationCoordinator,
    private readonly sweeps: PostEventFeedbackSweepService,
    private readonly summaries: PostEventFeedbackCampaignSummaryService,
    private readonly wakeups: FeedbackConversationWakeupService,
  ) {
    super();
  }

  async process(
    job: Job<FeedbackJobData, void, FeedbackJobName>,
  ): Promise<void> {
    try {
      if (job.name === FEEDBACK_JOB_NAMES.relayOutboxV1) {
        const data = feedbackRelayJobDataSchema.parse(job.data);
        // Compatibility drain only. The direct PostgreSQL dispatcher is the
        // sole owner of pending rows; waking the retired relay here would
        // recreate a second delivery authority during rollout.
        this.logger.log({
          event: "feedback.relay_outbox.v1_discarded",
          jobId: job.id,
          correlationId: data.correlationId,
        });
        return;
      }

      if (job.name === FEEDBACK_JOB_NAMES.sweepRemindersV1) {
        const data = feedbackSweepJobDataSchema.parse(job.data);
        await this.wakeups.recoverDue(data.correlationId);
        return;
      }

      if (job.name === FEEDBACK_JOB_NAMES.sweepExpiryV1) {
        const data = feedbackSweepJobDataSchema.parse(job.data);
        await this.wakeups.recoverDue(data.correlationId);
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

        // A retained delivery job cannot prove whether an older worker entered
        // the provider call. Never send or release it. The direct dispatcher's
        // maintenance pass quarantines stale legacy `sending` rows instead.
        this.logger.log({
          event: "feedback.deliver.v1_discarded",
          jobId: job.id,
          correlationId: data.correlationId,
          outboxId: data.outboxId,
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
        const wakeupJobId = await this.wakeups.schedule({
          conversationId: data.conversationId,
          nextActionAt: new Date(),
          correlationId: data.correlationId,
        });
        this.logger.log({
          event: "feedback.extract.v1_converted",
          jobId: job.id,
          correlationId: data.correlationId,
          conversationId: data.conversationId,
          wakeupJobId,
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

        const wakeupJobId = await this.summaries.convertLegacyWakeup({
          campaignId: data.campaignId,
          attempt,
          correlationId: data.correlationId,
        });
        this.logger.log({
          event: "feedback.summarize_campaign.v1_converted",
          jobId: job.id,
          correlationId: data.correlationId,
          campaignId: data.campaignId,
          attempt,
          ...(wakeupJobId ? { wakeupJobId } : {}),
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
