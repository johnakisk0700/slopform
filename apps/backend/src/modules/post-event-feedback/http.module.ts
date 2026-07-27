import { Module } from "@nestjs/common";

import { AuditModule } from "../../infrastructure/audit/audit.module.js";
import { DatabaseModule } from "../../infrastructure/database/database.module.js";
import { QueueModule } from "../../infrastructure/queue/queue.module.js";
import { EventsCoreModule } from "../events/events-core.module.js";
import { ParticipantsCoreModule } from "../participants/participants-core.module.js";
import { FeedbackOutboundTranscriptService } from "./outbox/outbound-transcript.service.js";
import { PostEventFeedbackCampaignController } from "./campaign/campaign.controller.js";
import { PostEventFeedbackCampaignService } from "./campaign/campaign.service.js";
import {
  PostEventFeedbackConversationController,
  PostEventFeedbackNoteController,
} from "./inbox/conversation.controller.js";
import { PostEventFeedbackConversationService } from "./inbox/conversation.service.js";
import { PostEventFeedbackOutboxController } from "./outbox/queue-view.controller.js";
import { FeedbackOutboxQueueViewService } from "./outbox/queue-view.service.js";
import { PostEventFeedbackCoreModule } from "./core.module.js";

@Module({
  imports: [
    AuditModule,
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
    PostEventFeedbackOutboxController,
  ],
  providers: [
    FeedbackOutboundTranscriptService,
    FeedbackOutboxQueueViewService,
    PostEventFeedbackCampaignService,
    PostEventFeedbackConversationService,
  ],
  exports: [
    PostEventFeedbackCampaignService,
    PostEventFeedbackConversationService,
  ],
})
export class PostEventFeedbackHttpModule {}
