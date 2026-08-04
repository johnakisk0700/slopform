import { Module } from "@nestjs/common";

import { DatabaseModule } from "../../infrastructure/database/database.module.js";
import { MongoModule } from "../../infrastructure/mongo/mongo.module.js";
import { FeedbackCampaignRepository } from "./campaign/campaign.repository.js";
import { FeedbackResultsRepository } from "./extraction/results.repository.js";
import { FeedbackConversationExecutionFenceRepository } from "./extraction/execution-fence.repository.js";
import { FeedbackIngressRepository } from "./ingress/ingress.repository.js";
import { FeedbackOutboundLogRepository } from "./outbox/outbound-log.repository.js";
import { FeedbackOutboundLogService } from "./outbox/outbound-log.service.js";
import { FeedbackOutboxRepository } from "./outbox/outbox.repository.js";
import { FeedbackConversationRepository } from "./post-event-feedback-conversation.repository.js";
import { FeedbackSimOutboundRepository } from "./simulator/sim-outbound.repository.js";
import { FeedbackMaintenanceCheckpointRepository } from "./sweeps/maintenance-checkpoint.repository.js";

@Module({
  imports: [DatabaseModule, MongoModule],
  providers: [
    FeedbackCampaignRepository,
    FeedbackConversationRepository,
    FeedbackResultsRepository,
    FeedbackConversationExecutionFenceRepository,
    FeedbackIngressRepository,
    FeedbackOutboxRepository,
    FeedbackOutboundLogRepository,
    FeedbackOutboundLogService,
    FeedbackSimOutboundRepository,
    FeedbackMaintenanceCheckpointRepository,
  ],
  exports: [
    FeedbackCampaignRepository,
    FeedbackConversationRepository,
    FeedbackResultsRepository,
    FeedbackConversationExecutionFenceRepository,
    FeedbackIngressRepository,
    FeedbackOutboxRepository,
    FeedbackOutboundLogRepository,
    FeedbackOutboundLogService,
    FeedbackSimOutboundRepository,
    FeedbackMaintenanceCheckpointRepository,
  ],
})
export class PostEventFeedbackCoreModule {}
