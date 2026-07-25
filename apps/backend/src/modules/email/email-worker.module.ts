import { Module } from "@nestjs/common";

import { QueueWorkerModule } from "../../infrastructure/queue/queue.module.js";
import { EmailCoreModule } from "./email-core.module.js";
import { EmailOutboxRelayService } from "./email-outbox-relay.service.js";
import { EmailSchedulerService } from "./email-scheduler.service.js";
import { EmailProcessor } from "./email.processor.js";

@Module({
  imports: [QueueWorkerModule, EmailCoreModule],
  providers: [EmailOutboxRelayService, EmailProcessor, EmailSchedulerService],
})
export class EmailWorkerModule {}
