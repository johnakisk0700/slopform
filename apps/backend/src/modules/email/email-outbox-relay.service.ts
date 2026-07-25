import { InjectQueue } from "@nestjs/bullmq";
import { Injectable } from "@nestjs/common";
import type { Queue } from "bullmq";

import { EMAIL_QUEUE } from "../../infrastructure/queue/queue.constants.js";
import { EmailRepository } from "./email.repository.js";
import {
  createEmailDeliverJobId,
  EMAIL_JOB_NAMES,
  EMAIL_JOB_SCHEMA_VERSION,
  emailDeliverJobDataSchema,
  type EmailJobData,
  type EmailJobName,
} from "./email.schemas.js";

export const EMAIL_OUTBOX_BATCH_SIZE = 50;
export const EMAIL_OUTBOX_LEASE_MS = 60_000;
export const EMAIL_OUTBOX_RETRY_MS = 30_000;
export const EMAIL_DISPATCH_RECOVERY_MS = 5 * 60_000;

export class EmailOutboxRelayError extends Error {
  constructor() {
    super("One or more email outbox events could not be queued");
    this.name = EmailOutboxRelayError.name;
  }
}

@Injectable()
export class EmailOutboxRelayService {
  constructor(
    @InjectQueue(EMAIL_QUEUE)
    private readonly queue: Queue<EmailJobData, void, EmailJobName>,
    private readonly repository: EmailRepository,
  ) {}

  async relay(now = new Date()): Promise<number> {
    const events = await this.repository.claimOutboxBatch(
      now,
      new Date(now.getTime() + EMAIL_OUTBOX_LEASE_MS),
      EMAIL_OUTBOX_BATCH_SIZE,
    );
    let failed = false;

    for (const event of events) {
      const data = emailDeliverJobDataSchema.parse({
        schemaVersion: EMAIL_JOB_SCHEMA_VERSION,
        deliveryId: event.deliveryId,
        outboxEventId: event.id,
        correlationId: event.correlationId,
      });
      try {
        await this.queue.add(EMAIL_JOB_NAMES.deliverV1, data, {
          jobId: createEmailDeliverJobId(event.id),
          attempts: 1,
          removeOnComplete: true,
          removeOnFail: true,
          stackTraceLimit: 3,
        });
        await this.repository.markOutboxDispatched(
          event,
          now,
          new Date(now.getTime() + EMAIL_DISPATCH_RECOVERY_MS),
        );
      } catch {
        failed = true;
        await this.repository.releaseOutbox(
          event,
          new Date(now.getTime() + EMAIL_OUTBOX_RETRY_MS),
          "queue_unavailable",
        );
      }
    }

    if (failed) {
      throw new EmailOutboxRelayError();
    }
    return events.length;
  }
}
