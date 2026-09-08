import { Module } from "@nestjs/common";
import { ConditionalModule } from "@nestjs/config";

import { isResendEnabled } from "../../infrastructure/config/enabled-modules.js";
import { QueueWorkerModule } from "../../infrastructure/queue/queue.module.js";
import { ResendClientModule } from "../../integrations/resend/resend-client.module.js";
import { EmailCoreModule } from "./email-core.module.js";
import { EmailOutboxRelayService } from "./email-outbox-relay.service.js";
import { EmailSchedulerService } from "./email-scheduler.service.js";
import { EmailProcessor } from "./email.processor.js";

@Module({
  imports: [
    QueueWorkerModule,
    EmailCoreModule,
    ConditionalModule.registerWhen(ResendClientModule, isResendEnabled),
  ],
  providers: [EmailOutboxRelayService, EmailProcessor, EmailSchedulerService],
})
export class EmailWorkerModule {}
