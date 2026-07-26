import { Module } from "@nestjs/common";

import { AuditModule } from "../../infrastructure/audit/audit.module.js";
import { DatabaseModule } from "../../infrastructure/database/database.module.js";
import { QueueModule } from "../../infrastructure/queue/queue.module.js";
import { ConversationThreadModule } from "../conversations/conversation-thread.module.js";
import { EventsCoreModule } from "../events/events-core.module.js";
import { ParticipantsCoreModule } from "../participants/participants-core.module.js";
import { FeedbackOutboundTranscriptService } from "./outbox/outbound-transcript.service.js";
import { PostEventFeedbackCampaignController } from "./post-event-feedback-campaign.controller.js";
import { PostEventFeedbackCampaignService } from "./post-event-feedback-campaign.service.js";
import {
  PostEventFeedbackConversationController,
  PostEventFeedbackNoteController,
} from "./post-event-feedback-conversation.controller.js";
import { PostEventFeedbackConversationService } from "./post-event-feedback-conversation.service.js";
import { PostEventFeedbackCoreModule } from "./post-event-feedback-core.module.js";

@Module({
  imports: [
    AuditModule,
    ConversationThreadModule,
    DatabaseModule,
    EventsCoreModule,
    ParticipantsCoreModule,
    PostEventFeedbackCoreModule,
    // Resuming the bot may have to queue the extraction for testimony that
    // arrived while a person held the conversation.
    QueueModule,
  ],
  controllers: [
    PostEventFeedbackCampaignController,
    PostEventFeedbackConversationController,
    PostEventFeedbackNoteController,
  ],
  providers: [
    FeedbackOutboundTranscriptService,
    PostEventFeedbackCampaignService,
    PostEventFeedbackConversationService,
  ],
  exports: [
    PostEventFeedbackCampaignService,
    PostEventFeedbackConversationService,
  ],
})
export class PostEventFeedbackHttpModule {}
