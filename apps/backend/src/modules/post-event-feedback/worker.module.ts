import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";

import type { Environment } from "../../infrastructure/config/environment.js";
import { AuditModule } from "../../infrastructure/audit/audit.module.js";
import { DatabaseModule } from "../../infrastructure/database/database.module.js";
import { QueueWorkerModule } from "../../infrastructure/queue/queue.module.js";
import { WasenderClient } from "../../integrations/wasender/wasender.client.js";
import { EventsCoreModule } from "../events/events-core.module.js";
import { ParticipantsCoreModule } from "../participants/participants-core.module.js";
import {
  FEEDBACK_OPERATOR_ALERT,
  LoggingFeedbackOperatorAlert,
} from "./operator-alert.js";
import { FeedbackOutboxSchedulerService } from "./outbox/relay-scheduler.service.js";
import { FeedbackOutboundTranscriptService } from "./outbox/outbound-transcript.service.js";
import { FeedbackSweepSchedulerService } from "./sweeps/sweep-scheduler.service.js";
import { FEEDBACK_TRANSPORT } from "./outbox/transport.js";
import { MessageOutboxDeliveryService } from "./outbox/deliver.service.js";
import { MessageOutboxRelayService } from "./outbox/relay.service.js";
import { PostEventFeedbackCoreModule } from "./core.module.js";
import { createFeedbackExtractionModel } from "./burst/create-feedback-extraction-model.js";
import { BURST_PERSONAS } from "./burst/burst-personas.js";
import { PostEventFeedbackExtractionFallback } from "./extraction/fallback.service.js";
import { PostEventFeedbackExtractionModel } from "./extraction/model.service.js";
import { PostEventFeedbackExtractor } from "./extraction/extract.service.js";
import { PostEventFeedbackMaterializer } from "./ingress/materialize.service.js";
import { PostEventFeedbackMetrics } from "./metrics.service.js";
import { PostEventFeedbackIngressProcessor } from "./ingress/ingress.processor.js";
import { PostEventFeedbackProcessor } from "./processor.js";
import { PostEventFeedbackSweepService } from "./sweeps/sweep.service.js";
import { PostEventFeedbackCampaignSummaryService } from "./summary/summary.service.js";
import { SimulatedFeedbackTransport } from "./outbox/simulated-transport.service.js";
import { WasenderFeedbackTransport } from "./outbox/wasender-transport.service.js";

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
    DatabaseModule,
    EventsCoreModule,
    ParticipantsCoreModule,
    PostEventFeedbackCoreModule,
    QueueWorkerModule,
  ],
  providers: [
    FeedbackOutboundTranscriptService,
    // The operator alert seam. Only the log implementation exists today; the
    // token is what lets a future channel be swapped in without touching the
    // two call sites that raise it.
    {
      provide: FEEDBACK_OPERATOR_ALERT,
      useClass: LoggingFeedbackOperatorAlert,
    },
    PostEventFeedbackExtractionFallback,
    {
      provide: PostEventFeedbackExtractionModel,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Environment, true>) =>
        createFeedbackExtractionModel(config, BURST_PERSONAS),
    },
    PostEventFeedbackExtractor,
    PostEventFeedbackMaterializer,
    PostEventFeedbackMetrics,
    MessageOutboxRelayService,
    MessageOutboxDeliveryService,
    FeedbackOutboxSchedulerService,
    FeedbackSweepSchedulerService,
    PostEventFeedbackSweepService,
    PostEventFeedbackCampaignSummaryService,
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
    PostEventFeedbackIngressProcessor,
  ],
  exports: [
    PostEventFeedbackExtractor,
    PostEventFeedbackMaterializer,
    FEEDBACK_TRANSPORT,
  ],
})
export class PostEventFeedbackWorkerModule {}
