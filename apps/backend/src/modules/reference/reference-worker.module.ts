import { Module } from "@nestjs/common";

import { QueueModule } from "../../infrastructure/queue/queue.module.js";
import { ReferenceCoreModule } from "./reference-core.module.js";
import { ReferenceProcessor } from "./reference.processor.js";

@Module({
  imports: [QueueModule, ReferenceCoreModule],
  providers: [ReferenceProcessor],
})
export class ReferenceWorkerModule {}
