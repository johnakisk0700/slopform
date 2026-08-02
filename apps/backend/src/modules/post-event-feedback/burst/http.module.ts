import { Module } from "@nestjs/common";

import { QueueModule } from "../../../infrastructure/queue/queue.module.js";
import { FeedbackBurstController } from "./burst.controller.js";

/**
 * Clerk-protected HTTP surface for the multi-campaign burst rehearsal.
 * Mounted only when `FEEDBACK_SIMULATOR_ENABLED` is true, `TRANSPORT_MODE` is
 * `simulated`, and production has the explicit rehearsal gate — the same policy
 * as the simulator module. Imports `QueueModule` so the catalogue can report
 * whether a feedback worker is registered before the runner starts a thread per
 * persona.
 */
@Module({
  imports: [QueueModule],
  controllers: [FeedbackBurstController],
})
export class PostEventFeedbackBurstHttpModule {}
