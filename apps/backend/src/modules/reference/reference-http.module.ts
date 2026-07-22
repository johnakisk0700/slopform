import { Module } from "@nestjs/common";

import { QueueModule } from "../../infrastructure/queue/queue.module.js";
import { ReferenceController } from "./reference.controller.js";
import { ReferenceCoreModule } from "./reference-core.module.js";
import { ReferenceJobsService } from "./reference-jobs.service.js";

@Module({
  imports: [QueueModule, ReferenceCoreModule],
  controllers: [ReferenceController],
  providers: [ReferenceJobsService],
})
export class ReferenceHttpModule {}
