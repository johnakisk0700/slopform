import { Module } from "@nestjs/common";

import { QueueWorkerModule } from "../../infrastructure/queue/queue.module.js";
import { AssistantGenerationService } from "./assistant-generation.service.js";
import { AssistantRecoveryService } from "./assistant-recovery.service.js";
import { AssistantCoreModule } from "./assistant-core.module.js";
import { AssistantProcessor } from "./assistant.processor.js";

@Module({
  imports: [QueueWorkerModule, AssistantCoreModule],
  providers: [
    AssistantGenerationService,
    AssistantProcessor,
    AssistantRecoveryService,
  ],
})
export class AssistantWorkerModule {}
