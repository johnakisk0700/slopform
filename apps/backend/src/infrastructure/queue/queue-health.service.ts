import { InjectQueue } from "@nestjs/bullmq";
import { Injectable } from "@nestjs/common";
import type { Queue } from "bullmq";

import { REFERENCE_QUEUE } from "./queue.constants.js";

@Injectable()
export class QueueHealthService {
  constructor(@InjectQueue(REFERENCE_QUEUE) private readonly queue: Queue) {}

  async ping(): Promise<void> {
    await this.queue.getJobCounts("wait", "active", "delayed", "failed");
  }
}
