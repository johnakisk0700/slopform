import { Module } from "@nestjs/common";

import { DatabaseModule } from "../../infrastructure/database/database.module.js";
import { QueueModule } from "../../infrastructure/queue/queue.module.js";
import { MessageOutboxDeliveryStatusService } from "./message-outbox-delivery-status.service.js";
import { PostEventFeedbackCoreModule } from "./post-event-feedback-core.module.js";
import { PostEventFeedbackIngressService } from "./post-event-feedback-ingress.service.js";

/**
 * The HTTP-side half of the feedback pipeline: one durable ingress write and
 * one producer enqueue for observed messages, plus delivery-column updates for
 * `messages.update`. It carries no conversation, participant or extraction
 * providers, so the webhook edge cannot grow domain logic by accident.
 */
@Module({
  imports: [DatabaseModule, QueueModule, PostEventFeedbackCoreModule],
  providers: [
    PostEventFeedbackIngressService,
    MessageOutboxDeliveryStatusService,
  ],
  exports: [
    PostEventFeedbackIngressService,
    MessageOutboxDeliveryStatusService,
  ],
})
export class PostEventFeedbackIngressModule {}
