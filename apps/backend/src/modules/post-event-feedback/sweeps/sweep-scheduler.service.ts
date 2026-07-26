import { InjectQueue } from "@nestjs/bullmq";
import { Injectable, type OnApplicationBootstrap } from "@nestjs/common";
import type { Queue } from "bullmq";

import { FEEDBACK_QUEUE } from "../../../infrastructure/queue/queue.constants.js";
import {
  FEEDBACK_JOB_NAMES,
  FEEDBACK_JOB_SCHEMA_VERSION,
  feedbackSweepJobDataSchema,
  type FeedbackJobData,
} from "../jobs.schemas.js";

const FEEDBACK_REMINDER_SWEEP_SCHEDULER_ID =
  FEEDBACK_JOB_NAMES.sweepRemindersV1;
const FEEDBACK_EXPIRY_SWEEP_SCHEDULER_ID = FEEDBACK_JOB_NAMES.sweepExpiryV1;
const FEEDBACK_INGRESS_SWEEP_SCHEDULER_ID = FEEDBACK_JOB_NAMES.sweepIngressV1;

/** Reminder / expiry / ingress recovery share a five-minute cadence. */
export const FEEDBACK_SWEEP_EVERY_MS = 5 * 60_000;

@Injectable()
export class FeedbackSweepSchedulerService implements OnApplicationBootstrap {
  constructor(
    @InjectQueue(FEEDBACK_QUEUE)
    private readonly queue: Queue<FeedbackJobData, void, string>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await Promise.all([
      this.upsert(
        FEEDBACK_REMINDER_SWEEP_SCHEDULER_ID,
        FEEDBACK_JOB_NAMES.sweepRemindersV1,
      ),
      this.upsert(
        FEEDBACK_EXPIRY_SWEEP_SCHEDULER_ID,
        FEEDBACK_JOB_NAMES.sweepExpiryV1,
      ),
      this.upsert(
        FEEDBACK_INGRESS_SWEEP_SCHEDULER_ID,
        FEEDBACK_JOB_NAMES.sweepIngressV1,
      ),
    ]);
  }

  private async upsert(
    schedulerId: string,
    name:
      | typeof FEEDBACK_JOB_NAMES.sweepRemindersV1
      | typeof FEEDBACK_JOB_NAMES.sweepExpiryV1
      | typeof FEEDBACK_JOB_NAMES.sweepIngressV1,
  ): Promise<void> {
    const data = feedbackSweepJobDataSchema.parse({
      schemaVersion: FEEDBACK_JOB_SCHEMA_VERSION,
      correlationId: schedulerId,
    });
    await this.queue.upsertJobScheduler(
      schedulerId,
      { every: FEEDBACK_SWEEP_EVERY_MS },
      {
        name,
        data,
        opts: {
          attempts: 1,
          removeOnComplete: true,
          removeOnFail: true,
          stackTraceLimit: 3,
        },
      },
    );
  }
}
