import { Module } from "@nestjs/common";

import { AuditModule } from "../../infrastructure/audit/audit.module.js";
import { DatabaseModule } from "../../infrastructure/database/database.module.js";
import { ReferenceRepository } from "./reference.repository.js";
import { ReferenceService } from "./reference.service.js";

@Module({
  imports: [AuditModule, DatabaseModule],
  providers: [ReferenceRepository, ReferenceService],
  exports: [ReferenceService],
})
export class ReferenceCoreModule {}
