import { Module } from "@nestjs/common";

import { AuditRepository } from "./audit.repository.js";

@Module({
  providers: [AuditRepository],
  exports: [AuditRepository],
})
export class AuditModule {}
