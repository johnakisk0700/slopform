import { InjectQueue } from "@nestjs/bullmq";
import { Injectable, type OnApplicationBootstrap } from "@nestjs/common";
import type { Queue } from "bullmq";

import { FEEDBACK_QUEUE } from "../../../infrastructure/queue/queue.constants.js";
import {
  FEEDBACK_JOB_NAMES,
  FEEDBACK_JOB_SCHEMA_VERSION,
  feedbackRelayJobDataSchema,
  type FeedbackJobData,
  type FeedbackJobName,
} from "../jobs.schemas.js";

const FEEDBACK_OUTBOX_RELAY_SCHEDULER_ID = FEEDBACK_JOB_NAMES.relayOutboxV1;
const FEEDBACK_OUTBOX_RELAY_EVERY_MS = 5_000;

@Injectable()
export class FeedbackOutboxSchedulerService implements OnApplicationBootstrap {
  constructor(
    @InjectQueue(FEEDBACK_QUEUE)
    private readonly queue: Queue<FeedbackJobData, void, FeedbackJobName>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const data = feedbackRelayJobDataSchema.parse({
      schemaVersion: FEEDBACK_JOB_SCHEMA_VERSION,
      correlationId: FEEDBACK_OUTBOX_RELAY_SCHEDULER_ID,
    });
    await this.queue.upsertJobScheduler(
      FEEDBACK_OUTBOX_RELAY_SCHEDULER_ID,
      { every: FEEDBACK_OUTBOX_RELAY_EVERY_MS },
      {
        name: FEEDBACK_JOB_NAMES.relayOutboxV1,
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
