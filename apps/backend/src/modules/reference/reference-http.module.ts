import { Module } from "@nestjs/common";

import { ReferenceController } from "./reference.controller.js";
import { ReferenceCoreModule } from "./reference-core.module.js";
import { ReferenceGuard } from "./reference.guard.js";
import { ReferenceJobsService } from "./reference-jobs.service.js";

@Module({
  imports: [ReferenceCoreModule],
  controllers: [ReferenceController],
  providers: [ReferenceGuard, ReferenceJobsService],
})
export class ReferenceHttpModule {}
