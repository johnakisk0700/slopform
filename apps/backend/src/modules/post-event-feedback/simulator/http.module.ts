import { Module } from "@nestjs/common";

import { DatabaseModule } from "../../../infrastructure/database/database.module.js";
import { QueueModule } from "../../../infrastructure/queue/queue.module.js";
import { EventsCoreModule } from "../../events/events-core.module.js";
import { ParticipantsCoreModule } from "../../participants/participants-core.module.js";
import { FeedbackSimulatorController } from "./simulator.controller.js";
import { FeedbackSimulatorService } from "./simulator.service.js";
import { FeedbackOutboundTranscriptService } from "../outbox/outbound-transcript.service.js";
import { PostEventFeedbackIngressModule } from "../ingress/ingress.module.js";
import { PostEventFeedbackCoreModule } from "../core.module.js";

/**
 * Dev/staging-only HTTP surface for the simulated feedback transport (WP8).
 * Mounted only when `FEEDBACK_SIMULATOR_ENABLED` is true, `TRANSPORT_MODE` is
 * `simulated`, and `NODE_ENV` is not `production`.
 */
@Module({
  imports: [
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
