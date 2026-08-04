import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";

import type { Environment } from "../../infrastructure/config/environment.js";
import { AuditModule } from "../../infrastructure/audit/audit.module.js";
import { DatabaseModule } from "../../infrastructure/database/database.module.js";
import { QueueWorkerModule } from "../../infrastructure/queue/queue.module.js";
import { ProviderCallLimiter } from "../../infrastructure/ai/provider-call-limiter.js";
import { WasenderClient } from "../../integrations/wasender/wasender.client.js";
import { EventsCoreModule } from "../events/events-core.module.js";
import { ParticipantsCoreModule } from "../participants/participants-core.module.js";
import {
  FEEDBACK_OPERATOR_ALERT,
  LoggingFeedbackOperatorAlert,
} from "./operator-alert.js";
import { FeedbackOutboxDispatcherLoop } from "./outbox/dispatcher-loop.service.js";
import { MessageOutboxDispatcherService } from "./outbox/dispatcher.service.js";
import { FeedbackOutboundTranscriptService } from "./outbox/outbound-transcript.service.js";
import { FeedbackSweepSchedulerService } from "./sweeps/sweep-scheduler.service.js";
import { PostEventFeedbackMaintenanceService } from "./sweeps/maintenance.service.js";
import { PostEventFeedbackMaintenanceProcessor } from "./sweeps/maintenance.processor.js";
import {
  FEEDBACK_TRANSPORT,
  type FeedbackTransport,
} from "./outbox/transport.js";
import { PostEventFeedbackCoreModule } from "./core.module.js";
import { createFeedbackExtractionModel } from "./burst/create-feedback-extraction-model.js";
import { BURST_PERSONAS } from "./burst/burst-personas.js";
import { PostEventFeedbackExtractionFallback } from "./extraction/fallback.service.js";
import { FeedbackConversationExecutionLimiter } from "./extraction/execution-limiter.service.js";
import { PostEventFeedbackExtractionModel } from "./extraction/model.service.js";
import { PostEventFeedbackExtractor } from "./extraction/extract.service.js";
import { FeedbackConversationExecutionFence } from "./extraction/execution-fence.service.js";
import { PostEventFeedbackMaterializer } from "./ingress/materialize.service.js";
import { FeedbackMaterializeWakeupService } from "./ingress/materialize-wakeup.service.js";
import {
  FeedbackMaterializationLimiter,
  PostEventFeedbackMaterializationCoordinator,
} from "./ingress/materialization-coordinator.service.js";
import { PostEventFeedbackMetrics } from "./metrics.service.js";
import { PostEventFeedbackIngressProcessor } from "./ingress/ingress.processor.js";
import { PostEventFeedbackProcessor } from "./processor.js";
import { PostEventFeedbackSweepService } from "./sweeps/sweep.service.js";
import { PostEventFeedbackCampaignSummaryService } from "./summary/summary.service.js";
import { PostEventFeedbackSummaryProcessor } from "./summary/summary.processor.js";
import { DisabledFeedbackTransport } from "./outbox/disabled-transport.service.js";
import { SimulatedFeedbackTransport } from "./outbox/simulated-transport.service.js";
import { WasenderFeedbackTransport } from "./outbox/wasender-transport.service.js";
import {
  FEEDBACK_SEND_LIMITER,
  FeedbackSendLimiterService,
} from "./outbox/session-pacer.js";
import { FeedbackConversationWakeupService } from "./reconciliation/wakeup.service.js";
import { FeedbackConversationReconcileService } from "./reconciliation/reconcile.service.js";
import { FeedbackConversationReconcileProcessor } from "./reconciliation/reconcile.processor.js";
import { FeedbackCampaignResumeRepairService } from "./campaign/resume-repair.service.js";

export function createFeedbackTransport(
  mode: Environment["TRANSPORT_MODE"],
  wasender: WasenderClient | undefined,
  simulated: SimulatedFeedbackTransport,
  disabled: DisabledFeedbackTransport,
): FeedbackTransport {
  if (mode === "wasender") {
    if (!wasender) {
      throw new Error(
        "WASENDER_SESSION_API_KEY is required when TRANSPORT_MODE=wasender",
      );
    }
    return new WasenderFeedbackTransport(wasender);
  }

  return mode === "simulated" ? simulated : disabled;
}

/**
 * The worker-side half: immediate ingress materialization, durable conversation
 * reconciliation, campaign summaries, one maintenance repair pass and direct
 * PostgreSQL outbox dispatch. BullMQ carries identifier-only wake-ups; it does
 * not own conversation or delivery state. V1 feedback consumers remain only to
 * drain jobs created before the reader-first cutover.
 *
 * `EventsCoreModule` is imported for one reason: extraction selects candidates
 * live through `EventsService.listFeedbackCandidatesForRespondent`, the single
 * D16 helper shared with prompt building and subject validation. This module
 * must never grow a second candidate query of its own.
 *
 * The model provider and the transport adapter both live here, so the HTTP
 * process holds neither a provider client nor a sender for this feature. The
 * two halves meet only through `message_outbox`: extraction inserts a row and
 * the direct dispatcher token-claims it.
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
    FeedbackConversationExecutionLimiter,
    FeedbackConversationExecutionFence,
    FeedbackConversationWakeupService,
    FeedbackCampaignResumeRepairService,
    FeedbackConversationReconcileService,
    FeedbackConversationReconcileProcessor,
    {
      provide: PostEventFeedbackExtractionModel,
      inject: [ConfigService, ProviderCallLimiter],
      useFactory: (
        config: ConfigService<Environment, true>,
        providerCalls: ProviderCallLimiter,
      ) => createFeedbackExtractionModel(config, BURST_PERSONAS, providerCalls),
    },
    PostEventFeedbackExtractor,
    FeedbackMaterializeWakeupService,
    PostEventFeedbackMaterializer,
    FeedbackMaterializationLimiter,
    PostEventFeedbackMaterializationCoordinator,
    PostEventFeedbackMetrics,
    MessageOutboxDispatcherService,
    FeedbackOutboxDispatcherLoop,
    FeedbackSendLimiterService,
    {
      provide: FEEDBACK_SEND_LIMITER,
      useExisting: FeedbackSendLimiterService,
    },
    FeedbackSweepSchedulerService,
    PostEventFeedbackMaintenanceService,
    PostEventFeedbackMaintenanceProcessor,
    PostEventFeedbackSweepService,
    PostEventFeedbackCampaignSummaryService,
    PostEventFeedbackSummaryProcessor,
    DisabledFeedbackTransport,
    SimulatedFeedbackTransport,
    {
      provide: FEEDBACK_TRANSPORT,
      inject: [
        ConfigService,
        { token: WasenderClient, optional: true },
        SimulatedFeedbackTransport,
        DisabledFeedbackTransport,
      ],
      useFactory: (
        config: ConfigService<Environment, true>,
        wasender: WasenderClient | undefined,
        simulated: SimulatedFeedbackTransport,
        disabled: DisabledFeedbackTransport,
      ) =>
        createFeedbackTransport(
          config.get("TRANSPORT_MODE", { infer: true }),
          wasender,
          simulated,
          disabled,
        ),
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
