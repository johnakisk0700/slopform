import { InjectQueue } from "@nestjs/bullmq";
import { Injectable, type OnApplicationBootstrap } from "@nestjs/common";
import type { Queue } from "bullmq";

import { EMAIL_QUEUE } from "../../infrastructure/queue/queue.constants.js";
import {
  EMAIL_JOB_NAMES,
  EMAIL_JOB_SCHEMA_VERSION,
  emailRelayJobDataSchema,
  type EmailJobData,
  type EmailJobName,
} from "./email.schemas.js";

export const EMAIL_OUTBOX_RELAY_SCHEDULER_ID = EMAIL_JOB_NAMES.relayOutboxV1;
export const EMAIL_OUTBOX_RELAY_INTERVAL_MS = 5_000;

@Injectable()
export class EmailSchedulerService implements OnApplicationBootstrap {
  constructor(
    @InjectQueue(EMAIL_QUEUE)
    private readonly queue: Queue<EmailJobData, void, EmailJobName>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const data = emailRelayJobDataSchema.parse({
      schemaVersion: EMAIL_JOB_SCHEMA_VERSION,
      correlationId: EMAIL_OUTBOX_RELAY_SCHEDULER_ID,
    });
    await this.queue.upsertJobScheduler(
      EMAIL_OUTBOX_RELAY_SCHEDULER_ID,
      { every: EMAIL_OUTBOX_RELAY_INTERVAL_MS },
      {
        name: EMAIL_JOB_NAMES.relayOutboxV1,
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
