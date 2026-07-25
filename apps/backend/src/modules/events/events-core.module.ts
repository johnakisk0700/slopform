import { Module } from "@nestjs/common";

import { AuditModule } from "../../infrastructure/audit/audit.module.js";
import { DatabaseModule } from "../../infrastructure/database/database.module.js";
import { PostEventFeedbackCoreModule } from "../post-event-feedback/post-event-feedback-core.module.js";
import { EventsRepository } from "./events.repository.js";
import { EventsService } from "./events.service.js";

@Module({
  imports: [AuditModule, DatabaseModule, PostEventFeedbackCoreModule],
  providers: [EventsRepository, EventsService],
  exports: [EventsRepository, EventsService],
})
export class EventsCoreModule {}
