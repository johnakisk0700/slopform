import { Module } from "@nestjs/common";

import { AuditModule } from "../../infrastructure/audit/audit.module.js";
import { DatabaseModule } from "../../infrastructure/database/database.module.js";
import { EmailRepository } from "./email.repository.js";
import { EmailService } from "./email.service.js";

@Module({
  imports: [AuditModule, DatabaseModule],
  providers: [EmailRepository, EmailService],
  exports: [EmailRepository, EmailService],
})
export class EmailCoreModule {}
