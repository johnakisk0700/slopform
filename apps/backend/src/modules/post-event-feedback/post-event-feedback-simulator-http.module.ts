import { Module } from "@nestjs/common";

import { QueueModule } from "../../infrastructure/queue/queue.module.js";
import { FeedbackSimulatorController } from "./feedback-simulator.controller.js";
import { FeedbackSimulatorService } from "./feedback-simulator.service.js";
import { PostEventFeedbackIngressModule } from "./post-event-feedback-ingress.module.js";
import { PostEventFeedbackCoreModule } from "./post-event-feedback-core.module.js";

/**
 * Dev/staging-only HTTP surface for the simulated feedback transport (WP8).
 * Mounted only when `FEEDBACK_SIMULATOR_ENABLED` is true, `TRANSPORT_MODE` is
 * `simulated`, and `NODE_ENV` is not `production`.
 */
@Module({
  imports: [
    QueueModule,
    PostEventFeedbackCoreModule,
    PostEventFeedbackIngressModule,
  ],
  controllers: [FeedbackSimulatorController],
  providers: [FeedbackSimulatorService],
})
export class PostEventFeedbackSimulatorHttpModule {}
