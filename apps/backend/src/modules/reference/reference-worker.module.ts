import { Module } from "@nestjs/common";

import { QueueWorkerModule } from "../../infrastructure/queue/queue.module.js";
import { ReferenceCoreModule } from "./reference-core.module.js";
import { ReferenceProcessor } from "./reference.processor.js";

@Module({
  imports: [QueueWorkerModule, ReferenceCoreModule],
  providers: [ReferenceProcessor],
})
export class ReferenceWorkerModule {}
