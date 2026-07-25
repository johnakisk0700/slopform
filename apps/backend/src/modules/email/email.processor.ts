import { OnWorkerEvent, Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import { MetricsTime, UnrecoverableError, type Job } from "bullmq";
import { ZodError } from "zod";

import {
  EMAIL_QUEUE,
  QUEUE_WORKER_CONFIG,
} from "../../infrastructure/queue/queue.constants.js";
import { EmailOutboxRelayService } from "./email-outbox-relay.service.js";
import {
  createEmailDeliverJobId,
  EMAIL_JOB_NAMES,
  emailDeliverJobDataSchema,
  emailRelayJobDataSchema,
  type EmailJobData,
  type EmailJobName,
} from "./email.schemas.js";
import { EmailService } from "./email.service.js";

export const EMAIL_DELIVERY_LEASE_MS = 10 * 60_000;

@Processor(
  { name: EMAIL_QUEUE, configKey: QUEUE_WORKER_CONFIG },
  {
    concurrency: 2,
    maxStalledCount: 1,
    metrics: { maxDataPoints: MetricsTime.ONE_WEEK * 2 },
    name: "email-worker",
  },
)
export class EmailProcessor extends WorkerHost {
  private readonly logger = new Logger(EmailProcessor.name);

  constructor(
    private readonly email: EmailService,
    private readonly relay: EmailOutboxRelayService,
  ) {
    super();
  }

  async process(job: Job<EmailJobData, void, EmailJobName>): Promise<void> {
    try {
      if (job.name === EMAIL_JOB_NAMES.relayOutboxV1) {
        emailRelayJobDataSchema.parse(job.data);
        await this.relay.relay();
        return;
      }
      if (job.name === EMAIL_JOB_NAMES.deliverV1) {
        const data = emailDeliverJobDataSchema.parse(job.data);
        if (job.id !== createEmailDeliverJobId(data.outboxEventId)) {
          throw new UnrecoverableError("Invalid email delivery job id");
        }

        const now = new Date();
        await this.email.processWithoutProvider(
          data.deliveryId,
          data.outboxEventId,
          now,
          new Date(now.getTime() + EMAIL_DELIVERY_LEASE_MS),
        );
        return;
      }
      throw new UnrecoverableError(
        `Unsupported email job: ${String(job.name)}`,
      );
    } catch (error) {
      if (error instanceof ZodError) {
        throw new UnrecoverableError("Invalid email job payload");
      }
      throw error;
    }
  }

  @OnWorkerEvent("failed")
  onFailed(job: Job | undefined, error: Error, previous: string): void {
    this.logger.error({
      event: "queue.job.failed",
      queue: EMAIL_QUEUE,
      jobId: job?.id,
      jobName: job?.name,
      previous,
      error: { name: error.name },
    });
  }

  @OnWorkerEvent("stalled")
  onStalled(jobId: string, previous: string): void {
    this.logger.warn({
      event: "queue.job.stalled",
      queue: EMAIL_QUEUE,
      jobId,
      previous,
    });
  }

  @OnWorkerEvent("error")
  onError(error: Error): void {
    this.logger.error({
      event: "queue.worker.error",
      queue: EMAIL_QUEUE,
      error: { name: error.name },
    });
  }
}
