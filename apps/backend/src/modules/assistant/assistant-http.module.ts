import { Module } from "@nestjs/common";

import { QueueModule } from "../../infrastructure/queue/queue.module.js";
import { AssistantCoreModule } from "./assistant-core.module.js";
import { AssistantJobsService } from "./assistant-jobs.service.js";
import { AssistantController } from "./assistant.controller.js";

@Module({
  imports: [QueueModule, AssistantCoreModule],
  controllers: [AssistantController],
  providers: [AssistantJobsService],
})
export class AssistantHttpModule {}
