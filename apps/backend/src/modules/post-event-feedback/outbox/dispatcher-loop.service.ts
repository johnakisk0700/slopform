import { InjectQueue } from "@nestjs/bullmq";
import {
  Injectable,
  Logger,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
} from "@nestjs/common";
import type { Queue } from "bullmq";

import { FEEDBACK_QUEUE } from "../../../infrastructure/queue/queue.constants.js";
import { FEEDBACK_JOB_NAMES } from "../jobs.schemas.js";
import { MessageOutboxDispatcherService } from "./dispatcher.service.js";

export const FEEDBACK_OUTBOX_DISPATCH_INTERVAL_MS = 1_000;

/** Bounded, non-overlapping poll loop over PostgreSQL's durable outbox. */
@Injectable()
export class FeedbackOutboxDispatcherLoop
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger(FeedbackOutboxDispatcherLoop.name);
  private interval: NodeJS.Timeout | undefined;
  private pending: Promise<void> | undefined;

  constructor(
    @InjectQueue(FEEDBACK_QUEUE)
    private readonly legacyQueue: Queue,
    private readonly dispatcher: MessageOutboxDispatcherService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // Stop producing relay -> deliver jobs before the direct poller starts.
    // Jobs already active remain supported by the legacy processor during the
    // bridge; new pending rows are claimed only through PostgreSQL.
    await this.legacyQueue.removeJobScheduler(FEEDBACK_JOB_NAMES.relayOutboxV1);
    await this.run("startup");
    this.interval = setInterval(
      () => this.schedule(),
      FEEDBACK_OUTBOX_DISPATCH_INTERVAL_MS,
    );
    this.interval.unref();
  }

  async beforeApplicationShutdown(): Promise<void> {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
    await this.pending;
  }

  private schedule(): void {
    if (this.pending) return;
    const pending = this.run("periodic").finally(() => {
      if (this.pending === pending) this.pending = undefined;
    });
    this.pending = pending;
  }

  private async run(trigger: "startup" | "periodic"): Promise<void> {
    try {
      const result = await this.dispatcher.dispatchBatch();
      if (result.claimedCount > 0 || result.quarantinedCount > 0) {
        this.logger.log({
          event: "feedback.outbox.dispatch_batch",
          trigger,
          claimedCount: result.claimedCount,
          quarantinedCount: result.quarantinedCount,
          outcomes: result.items.map((item) => item.outcome),
        });
      }
    } catch (error) {
      this.logger.error({
        event: "feedback.outbox.dispatch_batch_failed",
        trigger,
        error: { name: error instanceof Error ? error.name : "Error" },
      });
    }
  }
}
