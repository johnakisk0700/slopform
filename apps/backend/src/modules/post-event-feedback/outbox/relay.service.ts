import { InjectQueue } from "@nestjs/bullmq";
import { Injectable } from "@nestjs/common";
import type { Queue } from "bullmq";

import {
  FEEDBACK_QUEUE,
  OUTBOX_RELAY_JOB_OPTIONS,
} from "../../../infrastructure/queue/queue.constants.js";
import {
  FEEDBACK_OUTBOX_BATCH_SIZE,
  FeedbackOutboxRepository,
} from "./outbox.repository.js";
import {
  createFeedbackDeliverJobId,
  FEEDBACK_JOB_NAMES,
  FEEDBACK_JOB_SCHEMA_VERSION,
  feedbackDeliverJobDataSchema,
  type FeedbackJobData,
  type FeedbackJobName,
} from "../jobs.schemas.js";

/** Extra delay between campaign intro/reminder jobs leased in the same batch. */
export const FEEDBACK_CAMPAIGN_STAGGER_MS = 2_000;

export class MessageOutboxRelayError extends Error {
  constructor() {
    super("One or more message outbox rows could not be queued");
    this.name = MessageOutboxRelayError.name;
  }
}

/**
 * PostgreSQL → BullMQ relay for `message_outbox`, following the email outbox
 * lease pattern. Rows with status `held` are never leased. Campaign intros and
 * reminders in the same batch receive a staggered BullMQ delay; session pacing
 * still applies at send time inside the Wasender transport.
 */
@Injectable()
export class MessageOutboxRelayService {
  constructor(
    @InjectQueue(FEEDBACK_QUEUE)
    private readonly queue: Queue<FeedbackJobData, void, FeedbackJobName>,
    private readonly repository: FeedbackOutboxRepository,
  ) {}

  async relay(now = new Date()): Promise<number> {
    const rows = await this.repository.claimOutboxBatch(
      now,
      FEEDBACK_OUTBOX_BATCH_SIZE,
    );
    let failed = false;
    let staggerIndex = 0;

    for (const row of rows) {
      const data = feedbackDeliverJobDataSchema.parse({
        schemaVersion: FEEDBACK_JOB_SCHEMA_VERSION,
        outboxId: row.id,
        correlationId: row.id,
      });
      const stagger =
        row.kind === "intro" || row.kind === "reminder"
          ? staggerIndex++ * FEEDBACK_CAMPAIGN_STAGGER_MS
          : 0;

      try {
        await this.queue.add(FEEDBACK_JOB_NAMES.deliverV1, data, {
          ...OUTBOX_RELAY_JOB_OPTIONS,
          jobId: createFeedbackDeliverJobId(row.id),
          ...(stagger > 0 ? { delay: stagger } : {}),
        });
      } catch {
        failed = true;
        await this.repository.releaseOutboxLease(row.id, now);
      }
    }

    if (failed) {
      throw new MessageOutboxRelayError();
    }
    return rows.length;
  }
}
