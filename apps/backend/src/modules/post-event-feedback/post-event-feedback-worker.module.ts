import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";

import type { Environment } from "../../infrastructure/config/environment.js";
import { AuditModule } from "../../infrastructure/audit/audit.module.js";
import { DatabaseModule } from "../../infrastructure/database/database.module.js";
import { QueueWorkerModule } from "../../infrastructure/queue/queue.module.js";
import { WasenderClient } from "../../integrations/wasender/wasender.client.js";
import { ConversationThreadModule } from "../conversations/conversation-thread.module.js";
import { EventsCoreModule } from "../events/events-core.module.js";
import { ParticipantsCoreModule } from "../participants/participants-core.module.js";
import { FeedbackOutboxSchedulerService } from "./feedback-outbox-scheduler.service.js";
import { FEEDBACK_TRANSPORT } from "./feedback-transport.js";
import { MessageOutboxDeliveryService } from "./message-outbox-delivery.service.js";
import { MessageOutboxRelayService } from "./message-outbox-relay.service.js";
import { PostEventFeedbackCoreModule } from "./post-event-feedback-core.module.js";
import { PostEventFeedbackExtractionModel } from "./post-event-feedback-extraction.service.js";
import { PostEventFeedbackExtractor } from "./post-event-feedback-extractor.service.js";
import { PostEventFeedbackMaterializer } from "./post-event-feedback-materializer.service.js";
import { PostEventFeedbackMetrics } from "./post-event-feedback-metrics.service.js";
import { PostEventFeedbackProcessor } from "./post-event-feedback.processor.js";
import { SimulatedFeedbackTransport } from "./simulated-feedback-transport.service.js";
import { WasenderFeedbackTransport } from "./wasender-feedback-transport.service.js";

/**
 * The worker-side half: the `feedback` queue consumer and every store it needs
 * to reload authoritative state. It uses the worker queue registration to
 * publish `feedback.extract.v1` and `feedback.deliver.v1`, the same
 * worker-side producer boundary the email outbox relay uses; HTTP never
 * publishes those jobs.
 *
 * `EventsCoreModule` is imported for one reason: extraction selects candidates
 * live through `EventsService.listFeedbackCandidatesForRespondent`, the single
 * D16 helper shared with prompt building and subject validation. This module
 * must never grow a second candidate query of its own.
 *
 * The model provider and the transport adapter both live here, so the HTTP
 * process holds neither a provider client nor a sender for this feature. The
 * two halves meet only through `message_outbox`: extraction inserts a row and
 * the relay leases it.
 */
@Module({
  imports: [
    AuditModule,
    ConfigModule,
    ConversationThreadModule,
    DatabaseModule,
    EventsCoreModule,
    ParticipantsCoreModule,
    PostEventFeedbackCoreModule,
    QueueWorkerModule,
  ],
  providers: [
    PostEventFeedbackExtractionModel,
    PostEventFeedbackExtractor,
    PostEventFeedbackMaterializer,
    PostEventFeedbackMetrics,
    MessageOutboxRelayService,
    MessageOutboxDeliveryService,
    FeedbackOutboxSchedulerService,
    SimulatedFeedbackTransport,
    {
      provide: FEEDBACK_TRANSPORT,
      inject: [
        ConfigService,
        { token: WasenderClient, optional: true },
        SimulatedFeedbackTransport,
      ],
      useFactory: (
        config: ConfigService<Environment, true>,
        wasender: WasenderClient | undefined,
        simulated: SimulatedFeedbackTransport,
      ) => {
        const mode = config.get("TRANSPORT_MODE", { infer: true });
        if (mode === "wasender") {
          if (!wasender) {
            throw new Error(
              "WASENDER_SESSION_API_KEY is required when TRANSPORT_MODE=wasender",
            );
          }
          return new WasenderFeedbackTransport(wasender);
        }
        return simulated;
      },
    },
    PostEventFeedbackProcessor,
  ],
  exports: [
    PostEventFeedbackExtractor,
    PostEventFeedbackMaterializer,
    FEEDBACK_TRANSPORT,
  ],
})
export class PostEventFeedbackWorkerModule {}
