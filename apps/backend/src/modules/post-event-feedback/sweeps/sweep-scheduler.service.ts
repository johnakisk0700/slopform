import { InjectQueue } from "@nestjs/bullmq";
import { Injectable, type OnApplicationBootstrap } from "@nestjs/common";
import type { Queue } from "bullmq";

import {
  FEEDBACK_MAINTENANCE_QUEUE,
  FEEDBACK_QUEUE,
} from "../../../infrastructure/queue/queue.constants.js";
import {
  FEEDBACK_JOB_NAMES,
  FEEDBACK_JOB_SCHEMA_VERSION_V2,
  feedbackMaintenanceJobDataSchema,
  type FeedbackJobData,
} from "../jobs.schemas.js";

const FEEDBACK_REMINDER_SWEEP_SCHEDULER_ID =
  FEEDBACK_JOB_NAMES.sweepRemindersV1;
const FEEDBACK_EXPIRY_SWEEP_SCHEDULER_ID = FEEDBACK_JOB_NAMES.sweepExpiryV1;
const FEEDBACK_INGRESS_SWEEP_SCHEDULER_ID = FEEDBACK_JOB_NAMES.sweepIngressV1;

/** One bounded state-repair pass every five minutes. */
export const FEEDBACK_SWEEP_EVERY_MS = 5 * 60_000;

@Injectable()
export class FeedbackSweepSchedulerService implements OnApplicationBootstrap {
  constructor(
    @InjectQueue(FEEDBACK_QUEUE)
    private readonly legacyQueue: Queue<FeedbackJobData, void, string>,
    @InjectQueue(FEEDBACK_MAINTENANCE_QUEUE)
    private readonly maintenanceQueue: Queue<FeedbackJobData, void, string>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const schedulerId = FEEDBACK_JOB_NAMES.maintenanceV2;
    const data = feedbackMaintenanceJobDataSchema.parse({
      schemaVersion: FEEDBACK_JOB_SCHEMA_VERSION_V2,
      correlationId: schedulerId,
    });
    await this.maintenanceQueue.upsertJobScheduler(
      schedulerId,
      { every: FEEDBACK_SWEEP_EVERY_MS },
      {
        name: FEEDBACK_JOB_NAMES.maintenanceV2,
        data,
        opts: {
          attempts: 1,
          removeOnComplete: true,
          removeOnFail: true,
          stackTraceLimit: 3,
        },
      },
    );
    await Promise.all([
      this.legacyQueue.removeJobScheduler(FEEDBACK_REMINDER_SWEEP_SCHEDULER_ID),
      this.legacyQueue.removeJobScheduler(FEEDBACK_EXPIRY_SWEEP_SCHEDULER_ID),
      this.legacyQueue.removeJobScheduler(FEEDBACK_INGRESS_SWEEP_SCHEDULER_ID),
    ]);
  }
}
