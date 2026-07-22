import { Module } from "@nestjs/common";

import { ReferenceCoreModule } from "./reference-core.module.js";
import { ReferenceProcessor } from "./reference.processor.js";

@Module({
  imports: [ReferenceCoreModule],
  providers: [ReferenceProcessor],
})
export class ReferenceWorkerModule {}
