import { Module } from "@nestjs/common";

import { DatabaseModule } from "../../infrastructure/database/database.module.js";
import { FeedbackCampaignRepository } from "./campaign/campaign.repository.js";
import { FeedbackResultsRepository } from "./extraction/results.repository.js";
import { FeedbackIngressRepository } from "./ingress/ingress.repository.js";
import { FeedbackOutboxRepository } from "./outbox/outbox.repository.js";
import { FeedbackSimOutboundRepository } from "./simulator/sim-outbound.repository.js";

@Module({
  imports: [DatabaseModule],
  providers: [
    FeedbackCampaignRepository,
    FeedbackResultsRepository,
    FeedbackIngressRepository,
    FeedbackOutboxRepository,
    FeedbackSimOutboundRepository,
  ],
  exports: [
    FeedbackCampaignRepository,
    FeedbackResultsRepository,
    FeedbackIngressRepository,
    FeedbackOutboxRepository,
    FeedbackSimOutboundRepository,
  ],
})
export class PostEventFeedbackCoreModule {}
