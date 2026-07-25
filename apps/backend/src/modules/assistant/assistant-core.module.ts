import { Module } from "@nestjs/common";

import { DatabaseModule } from "../../infrastructure/database/database.module.js";
import { AssistantRepository } from "./assistant.repository.js";
import { AssistantService } from "./assistant.service.js";

@Module({
  imports: [DatabaseModule],
  providers: [AssistantRepository, AssistantService],
  exports: [AssistantService],
})
export class AssistantCoreModule {}
