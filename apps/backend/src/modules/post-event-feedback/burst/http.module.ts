import { Module } from "@nestjs/common";

import { FeedbackBurstController } from "./burst.controller.js";

/**
 * Dev/staging-only HTTP surface for the multi-campaign burst rehearsal.
 * Mounted only when `FEEDBACK_SIMULATOR_ENABLED` is true, `TRANSPORT_MODE` is
 * `simulated`, and `NODE_ENV` is not `production` — the same gate as the
 * simulator module.
 */
@Module({
  controllers: [FeedbackBurstController],
})
export class PostEventFeedbackBurstHttpModule {}
