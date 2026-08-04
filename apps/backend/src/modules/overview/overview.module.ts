import { Module } from "@nestjs/common";

import { DatabaseModule } from "../../infrastructure/database/database.module.js";
import { PostEventFeedbackCoreModule } from "../post-event-feedback/core.module.js";
import { OverviewRepository } from "./overview.repository.js";
import { OverviewService } from "./overview.service.js";

@Module({
  imports: [DatabaseModule, PostEventFeedbackCoreModule],
  providers: [OverviewRepository, OverviewService],
  exports: [OverviewService],
})
export class OverviewModule {}
