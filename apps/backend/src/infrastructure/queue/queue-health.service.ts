import { InjectQueue } from "@nestjs/bullmq";
import { Injectable, Logger } from "@nestjs/common";
import type { Queue } from "bullmq";

import { withReadinessTimeout } from "../readiness.js";
import { REFERENCE_QUEUE } from "./queue.constants.js";

@Injectable()
export class QueueHealthService {
  private readonly logger = new Logger(QueueHealthService.name);
  private pendingPing: Promise<void> | undefined;

  constructor(@InjectQueue(REFERENCE_QUEUE) private readonly queue: Queue) {
    this.queue.on("error", (error: Error) => {
      this.logger.error({
        event: "queue.producer.error",
        queue: REFERENCE_QUEUE,
        error: {
          name: error.name,
          message: error.message,
          ...(error.stack ? { stack: error.stack } : {}),
        },
      });
    });
  }

  async ping(): Promise<void> {
    const ping = this.pendingPing ?? this.startPing();
    await withReadinessTimeout(ping, "Queue");
  }

  private startPing(): Promise<void> {
    const ping = this.queue
      .getJobCounts("wait", "active", "delayed", "failed")
      .then(() => undefined);

    this.pendingPing = ping.finally(() => {
      this.pendingPing = undefined;
    });

    return this.pendingPing;
  }
}
