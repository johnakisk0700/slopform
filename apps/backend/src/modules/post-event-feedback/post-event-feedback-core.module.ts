import { Module } from "@nestjs/common";

import { DatabaseModule } from "../../infrastructure/database/database.module.js";
import { PostEventFeedbackRepository } from "./post-event-feedback.repository.js";

@Module({
  imports: [DatabaseModule],
  providers: [PostEventFeedbackRepository],
  exports: [PostEventFeedbackRepository],
})
export class PostEventFeedbackCoreModule {}
