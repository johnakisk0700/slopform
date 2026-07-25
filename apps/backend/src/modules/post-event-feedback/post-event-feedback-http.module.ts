import { Module } from "@nestjs/common";

import { AuditModule } from "../../infrastructure/audit/audit.module.js";
import { DatabaseModule } from "../../infrastructure/database/database.module.js";
import { ConversationThreadModule } from "../conversations/conversation-thread.module.js";
import { EventsCoreModule } from "../events/events-core.module.js";
import { PostEventFeedbackCampaignController } from "./post-event-feedback-campaign.controller.js";
import { PostEventFeedbackCampaignService } from "./post-event-feedback-campaign.service.js";
import { PostEventFeedbackCoreModule } from "./post-event-feedback-core.module.js";

@Module({
  imports: [
    AuditModule,
    ConversationThreadModule,
    DatabaseModule,
    EventsCoreModule,
    PostEventFeedbackCoreModule,
  ],
  controllers: [PostEventFeedbackCampaignController],
  providers: [PostEventFeedbackCampaignService],
  exports: [PostEventFeedbackCampaignService],
})
export class PostEventFeedbackHttpModule {}
