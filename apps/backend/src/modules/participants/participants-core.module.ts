import { Module } from "@nestjs/common";

import { AuditModule } from "../../infrastructure/audit/audit.module.js";
import { DatabaseModule } from "../../infrastructure/database/database.module.js";
import { ParticipantsRepository } from "./participants.repository.js";
import { ParticipantsService } from "./participants.service.js";

@Module({
  imports: [AuditModule, DatabaseModule],
  providers: [ParticipantsRepository, ParticipantsService],
  exports: [ParticipantsRepository, ParticipantsService],
})
export class ParticipantsCoreModule {}
