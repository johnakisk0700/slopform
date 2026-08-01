import { Module } from "@nestjs/common";

import { DatabaseModule } from "../../infrastructure/database/database.module.js";
import { MongoModule } from "../../infrastructure/mongo/mongo.module.js";
import { FeedbackCampaignRepository } from "./campaign/campaign.repository.js";
import { FeedbackResultsRepository } from "./extraction/results.repository.js";
import { FeedbackIngressRepository } from "./ingress/ingress.repository.js";
import { FeedbackOutboundLogRepository } from "./outbox/outbound-log.repository.js";
import { FeedbackOutboundLogService } from "./outbox/outbound-log.service.js";
import { FeedbackOutboxRepository } from "./outbox/outbox.repository.js";
import { FeedbackConversationRepository } from "./post-event-feedback-conversation.repository.js";
import { FeedbackSimOutboundRepository } from "./simulator/sim-outbound.repository.js";

@Module({
  imports: [DatabaseModule, MongoModule],
  providers: [
    FeedbackCampaignRepository,
    FeedbackConversationRepository,
    FeedbackResultsRepository,
    FeedbackIngressRepository,
    FeedbackOutboxRepository,
    FeedbackOutboundLogRepository,
    FeedbackOutboundLogService,
    FeedbackSimOutboundRepository,
  ],
  exports: [
    FeedbackCampaignRepository,
    FeedbackConversationRepository,
    FeedbackResultsRepository,
    FeedbackIngressRepository,
    FeedbackOutboxRepository,
    FeedbackOutboundLogRepository,
    FeedbackOutboundLogService,
    FeedbackSimOutboundRepository,
  ],
})
export class PostEventFeedbackCoreModule {}
