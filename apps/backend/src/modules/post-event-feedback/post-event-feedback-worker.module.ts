import { Module } from "@nestjs/common";

import { AuditModule } from "../../infrastructure/audit/audit.module.js";
import { DatabaseModule } from "../../infrastructure/database/database.module.js";
import { QueueWorkerModule } from "../../infrastructure/queue/queue.module.js";
import { ConversationThreadModule } from "../conversations/conversation-thread.module.js";
import { ParticipantsCoreModule } from "../participants/participants-core.module.js";
import { PostEventFeedbackCoreModule } from "./post-event-feedback-core.module.js";
import { PostEventFeedbackMaterializer } from "./post-event-feedback-materializer.service.js";
import { PostEventFeedbackMetrics } from "./post-event-feedback-metrics.service.js";
import { PostEventFeedbackProcessor } from "./post-event-feedback.processor.js";

/**
 * The worker-side half: the `feedback` queue consumer and every store it needs
 * to reload authoritative state. It uses the worker queue registration to
 * publish `feedback.extract.v1`, the same worker-side producer boundary the
 * email outbox relay uses; HTTP never publishes extraction jobs.
 */
@Module({
  imports: [
    AuditModule,
    ConversationThreadModule,
    DatabaseModule,
    ParticipantsCoreModule,
    PostEventFeedbackCoreModule,
    QueueWorkerModule,
  ],
  providers: [
    PostEventFeedbackMaterializer,
    PostEventFeedbackMetrics,
    PostEventFeedbackProcessor,
  ],
  exports: [PostEventFeedbackMaterializer],
})
export class PostEventFeedbackWorkerModule {}
