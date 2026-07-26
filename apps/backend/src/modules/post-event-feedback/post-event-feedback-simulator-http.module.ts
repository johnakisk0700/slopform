import { Module } from "@nestjs/common";

import { DatabaseModule } from "../../infrastructure/database/database.module.js";
import { QueueModule } from "../../infrastructure/queue/queue.module.js";
import { ConversationThreadModule } from "../conversations/conversation-thread.module.js";
import { EventsCoreModule } from "../events/events-core.module.js";
import { ParticipantsCoreModule } from "../participants/participants-core.module.js";
import { FeedbackSimulatorController } from "./feedback-simulator.controller.js";
import { FeedbackSimulatorService } from "./feedback-simulator.service.js";
import { FeedbackOutboundTranscriptService } from "./feedback-outbound-transcript.service.js";
import { PostEventFeedbackIngressModule } from "./post-event-feedback-ingress.module.js";
import { PostEventFeedbackCoreModule } from "./post-event-feedback-core.module.js";

/**
 * Dev/staging-only HTTP surface for the simulated feedback transport (WP8).
 * Mounted only when `FEEDBACK_SIMULATOR_ENABLED` is true, `TRANSPORT_MODE` is
 * `simulated`, and `NODE_ENV` is not `production`.
 */
@Module({
  imports: [
    ConversationThreadModule,
    DatabaseModule,
    EventsCoreModule,
    ParticipantsCoreModule,
    QueueModule,
    PostEventFeedbackCoreModule,
    PostEventFeedbackIngressModule,
  ],
  controllers: [FeedbackSimulatorController],
  providers: [FeedbackOutboundTranscriptService, FeedbackSimulatorService],
})
export class PostEventFeedbackSimulatorHttpModule {}
