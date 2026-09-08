import {
  InjectQueue,
  OnWorkerEvent,
  Processor,
  WorkerHost,
} from "@nestjs/bullmq";
import type {
  BeforeApplicationShutdown,
  OnApplicationBootstrap,
} from "@nestjs/common";
import { UnrecoverableError, type Job, type Queue } from "bullmq";

import {
  FEEDBACK_OUTBOX_QUEUE,
  OUTBOX_RELAY_JOB_OPTIONS,
  QUEUE_WORKER_CONFIG,
} from "../../../infrastructure/queue/queue.constants.js";
import { FeedbackLogger } from "../feedback-operation-log.js";
import {
  FEEDBACK_JOB_NAMES,
  FEEDBACK_JOB_SCHEMA_VERSION_V2,
  feedbackOutboxPollJobDataSchema,
  type FeedbackOutboxPollJobData,
} from "../jobs.schemas.js";
import { MessageOutboxDispatcherService } from "./dispatcher.service.js";
import type { FeedbackOutboxDispatchBatchResult } from "./dispatcher.types.js";
import { FEEDBACK_OUTBOX_DISPATCH_BATCH_SIZE } from "./outbox.repository.js";

export const FEEDBACK_OUTBOX_POLL_LIMIT = 100;

const INITIAL_POLL_MS = 1_000;
const MIN_POLL_MS = 250;
const MAX_POLL_MS = 5_000;

/** BullMQ schedules batches; PostgreSQL owns each message's claim and outcome. */
@Processor(
  { name: FEEDBACK_OUTBOX_QUEUE, configKey: QUEUE_WORKER_CONFIG },
  { concurrency: 1, maxStalledCount: 1, name: "feedback-outbox-worker" },
)
export class FeedbackOutboxDispatchProcessor
  extends WorkerHost
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private stopping = false;
  private readonly logger = new FeedbackLogger(
    FeedbackOutboxDispatchProcessor.name,
  );

  constructor(
    @InjectQueue(FEEDBACK_OUTBOX_QUEUE) private readonly queue: Queue,
    private readonly dispatcher: MessageOutboxDispatcherService,
  ) {
    super();
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.setGlobalConcurrency(1);
    const scheduler = await this.queue.getJobScheduler(
      FEEDBACK_JOB_NAMES.dispatchOutboxV2,
    );
    await this.schedule(scheduler?.every ?? INITIAL_POLL_MS);
  }

  async process(
    job: Job<FeedbackOutboxPollJobData>,
  ): Promise<FeedbackOutboxDispatchBatchResult> {
    if (
      job.name !== FEEDBACK_JOB_NAMES.dispatchOutboxV2 ||
      !feedbackOutboxPollJobDataSchema.safeParse(job.data).success
    ) {
      throw new UnrecoverableError("Invalid feedback outbox poll job");
    }

    const items: FeedbackOutboxDispatchBatchResult["items"][number][] = [];
    let claimedCount = 0;
    let quarantinedCount = 0;
    while (!this.stopping && claimedCount < FEEDBACK_OUTBOX_POLL_LIMIT) {
      // Claim only the messages we can start now; a queued tail must not age its lease.
      const batch = await this.dispatcher.dispatchBatch();
      claimedCount += batch.claimedCount;
      quarantinedCount += batch.quarantinedCount;
      items.push(...batch.items);
      if (
        batch.claimedCount < FEEDBACK_OUTBOX_DISPATCH_BATCH_SIZE ||
        batch.items.some(
          (item) =>
            item.outcome === "deferred" || item.outcome === "claim_lost",
        )
      ) {
        break;
      }
    }
    const result = { claimedCount, quarantinedCount, items };
    const interval = Number(job.opts.repeat?.every ?? INITIAL_POLL_MS);
    const nextInterval = nextOutboxPollInterval(interval, result.claimedCount);
    if (!this.stopping && nextInterval !== interval) {
      await this.schedule(nextInterval);
    }

    if (result.claimedCount > 0 || result.quarantinedCount > 0) {
      this.logger.log({
        event: "feedback.outbox.dispatch_batch",
        jobId: job.id,
        claimedCount: result.claimedCount,
        quarantinedCount: result.quarantinedCount,
        outcomes: result.items.map((item) => item.outcome),
      });
    }
    return result;
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.stopping = true;
    // Drain the current claim wave before application-shutdown hooks close the database.
    await this.worker.close();
  }

  private async schedule(every: number): Promise<void> {
    await this.queue.upsertJobScheduler(
      FEEDBACK_JOB_NAMES.dispatchOutboxV2,
      { every },
      {
        name: FEEDBACK_JOB_NAMES.dispatchOutboxV2,
        data: {
          schemaVersion: FEEDBACK_JOB_SCHEMA_VERSION_V2,
          correlationId: FEEDBACK_JOB_NAMES.dispatchOutboxV2,
        } satisfies FeedbackOutboxPollJobData,
        // A failed batch is recovered from its rows on the next scheduled poll.
        opts: OUTBOX_RELAY_JOB_OPTIONS,
      },
    );
  }

  @OnWorkerEvent("failed")
  onFailed(job: Job | undefined, error: Error): void {
    this.logger.error({
      event: "feedback.outbox.dispatch_batch_failed",
      jobId: job?.id,
      error: { name: error.name },
    });
  }
}

export function nextOutboxPollInterval(
  currentMs: number,
  claimedCount: number,
): number {
  if (claimedCount >= FEEDBACK_OUTBOX_POLL_LIMIT) {
    return Math.max(MIN_POLL_MS, Math.floor(currentMs / 2));
  }
  if (claimedCount < FEEDBACK_OUTBOX_POLL_LIMIT / 2) {
    return Math.min(MAX_POLL_MS, currentMs * 2);
  }
  return currentMs;
}
