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
  FEEDBACK_CONVERSATION_QUEUE,
  QUEUE_WORKER_CONFIG,
} from "../../../infrastructure/queue/queue.constants.js";
import { PostEventFeedbackExtractionFallback } from "../extraction/fallback.service.js";
import { FeedbackConversationExecutionLimiter } from "../extraction/execution-limiter.service.js";
import {
  FeedbackExtractionGenerationError,
  isFeedbackProviderIncident,
} from "../extraction/model.service.js";
import {
  FeedbackConversationExecutionGuardError,
  PostEventFeedbackConversationNotFoundError,
} from "../extraction/extract.service.js";
import {
  createFeedbackReconcileConversationJobId,
  FEEDBACK_JOB_NAMES,
  feedbackReconcileConversationJobDataSchema,
  type FeedbackJobData,
  type FeedbackJobName,
} from "../jobs.schemas.js";
import { FeedbackConversationNotFoundError } from "../post-event-feedback-conversation.repository.js";
import { FEEDBACK_RECONCILIATION_INVARIANT_FAILURE_REASON } from "./reconcile-failure.js";
import { FeedbackConversationReconcileService } from "./reconcile.service.js";

export const FEEDBACK_CONVERSATION_WORKER_CONCURRENCY = 10;
export const FEEDBACK_CLAIM_BUSY_RETRY_MS = 15_000;

@Processor(
  { name: FEEDBACK_CONVERSATION_QUEUE, configKey: QUEUE_WORKER_CONFIG },
  {
    concurrency: FEEDBACK_CONVERSATION_WORKER_CONCURRENCY,
    maxStalledCount: 1,
    metrics: { maxDataPoints: MetricsTime.ONE_WEEK * 2 },
    name: "feedback-conversation-worker",
  },
)
export class FeedbackConversationReconcileProcessor extends WorkerHost {
  private readonly logger = new Logger(
    FeedbackConversationReconcileProcessor.name,
  );

  constructor(
    private readonly reconciler: FeedbackConversationReconcileService,
    private readonly fallback: PostEventFeedbackExtractionFallback,
    private readonly legacyConversationExecutions: FeedbackConversationExecutionLimiter,
  ) {
    super();
  }

  async process(
    job: Job<FeedbackJobData, void, FeedbackJobName>,
  ): Promise<void> {
    try {
      if (job.name !== FEEDBACK_JOB_NAMES.reconcileConversationV2) {
        throw new UnrecoverableError(
          `Unsupported feedback conversation job: ${String(job.name)}`,
        );
      }
      const data = feedbackReconcileConversationJobDataSchema.parse(job.data);
      if (
        job.id !==
        createFeedbackReconcileConversationJobId(
          data.conversationId,
          data.revision,
        )
      ) {
        throw new UnrecoverableError("Invalid feedback reconciliation job id");
      }

      // Temporary rollout bridge: an already-running V1 extraction knows only
      // this Redis mutex, while V2 owns the PostgreSQL commit fence. Holding the
      // old mutex around reconciliation *and* terminal fallback prevents the
      // two binaries from buying the same model call during queue drain. Remove
      // it together with the V1 extraction consumer after the retention gate.
      await this.legacyConversationExecutions.run(
        data.conversationId,
        async () => {
          try {
            const outcome = await this.reconciler.reconcile(data);
            if (outcome === "claim_busy") {
              // The current revision may already have published this successor
              // before releasing its PostgreSQL claim. Completing here would
              // let removeOnComplete swallow the only N+1 wake-up. Moving the
              // same job back to delayed is nonterminal and consumes no attempt.
              await job.moveToDelayed(
                Date.now() + FEEDBACK_CLAIM_BUSY_RETRY_MS,
                job.token,
              );
              throw new DelayedError();
            }
            this.logger.log({
              event: "feedback.reconciliation.completed",
              jobId: job.id,
              conversationId: data.conversationId,
              revision: data.revision,
              outcome,
            });
          } catch (error) {
            if (error instanceof DelayedError) {
              throw error;
            }
            const terminal = await this.applyTerminalFallback(job, data, error);
            throw terminal ?? error;
          }
        },
      );
    } catch (error) {
      if (error instanceof ZodError) {
        throw new UnrecoverableError("Invalid feedback reconciliation payload");
      }
      if (error instanceof FeedbackConversationExecutionGuardError) {
        if (error.reason === "authoritative_state_changed") {
          // Defense in depth: the reconciliation service normally translates
          // this into the successful `superseded` outcome itself.
          return;
        }
        if (error.reason === "execution_invariant_broken") {
          throw new UnrecoverableError(
            FEEDBACK_RECONCILIATION_INVARIANT_FAILURE_REASON,
          );
        }
        // A lost execution claim is transient ownership contention. Let BullMQ
        // apply the configured retry policy; no participant-facing fallback is
        // valid for an orchestration lease failure.
        throw error;
      }
      if (
        error instanceof FeedbackConversationNotFoundError ||
        error instanceof PostEventFeedbackConversationNotFoundError
      ) {
        throw new UnrecoverableError(error.message);
      }
      if (
        error instanceof FeedbackExtractionGenerationError &&
        !error.retryable
      ) {
        throw new UnrecoverableError(error.message);
      }
      throw error;
    }
  }

  private async applyTerminalFallback(
    job: Job<FeedbackJobData, void, FeedbackJobName>,
    data: { readonly conversationId: string; readonly correlationId: string },
    error: unknown,
  ): Promise<UnrecoverableError | undefined> {
    if (
      error instanceof FeedbackConversationExecutionGuardError ||
      error instanceof FeedbackConversationNotFoundError ||
      error instanceof PostEventFeedbackConversationNotFoundError
    ) {
      return undefined;
    }
    if (!(error instanceof FeedbackExtractionGenerationError)) {
      return undefined;
    }

    const permanent = !error.retryable;
    const exhausted = (job.attemptsMade ?? 0) + 1 >= (job.opts.attempts ?? 1);
    if (!permanent && !exhausted) {
      return undefined;
    }

    const providerIncident = isFeedbackProviderIncident(error);
    const cause = error.failureCause;
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
      this.logger.error({
        event: "feedback.reconciliation.fallback_failed",
        conversationId: data.conversationId,
        cause,
        error: {
          name: fallbackError instanceof Error ? fallbackError.name : "Error",
        },
      });
    }

    return new UnrecoverableError(
      providerIncident
        ? `Feedback extraction parked on the provider: ${cause}`
        : `Feedback extraction failed permanently: ${cause}`,
    );
  }

  @OnWorkerEvent("failed")
  onFailed(job: Job | undefined, error: Error, previous: string): void {
    this.logger.error({
      event: "queue.job.failed",
      queue: FEEDBACK_CONVERSATION_QUEUE,
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
}
