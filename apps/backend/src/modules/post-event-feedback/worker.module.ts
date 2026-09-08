import { PendingFeedbackIngressService } from "./ingress/pending-ingress.service.js";
import { FeedbackStopService } from "./ingress/stop.service.js";
import { FeedbackInboundMessageService } from "./ingress/inbound-message.service.js";
import { FeedbackClosedConversationIngressService } from "./ingress/closed-conversation-ingress.service.js";
import { FeedbackObservedOutboundService } from "./ingress/observed-outbound.service.js";
import { FeedbackDispatchSettlementService } from "./outbox/dispatch-settlement.service.js";
import { FeedbackDispatchPreparationService } from "./outbox/dispatch-preparation.service.js";
import { FeedbackDispatchRecoveryService } from "./outbox/dispatch-recovery.service.js";
import { FeedbackDispatchAttemptService } from "./outbox/dispatch-attempt.service.js";
import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";

import { FeedbackCampaignSummaryModel } from "../../integrations/llm/feedback-summary-model.js";
import type { Environment } from "../../infrastructure/config/environment.js";
import { AuditModule } from "../../infrastructure/audit/audit.module.js";
import { DatabaseModule } from "../../infrastructure/database/database.module.js";
import { QueueWorkerModule } from "../../infrastructure/queue/queue.module.js";
import { ProviderCallLimiter } from "../../integrations/llm/provider-call-limiter.js";
import { WasenderClient } from "../../integrations/wasender/wasender.client.js";
import { EventsCoreModule } from "../events/events-core.module.js";
import { ParticipantsCoreModule } from "../participants/participants-core.module.js";
import {
  FEEDBACK_OPERATOR_ALERT,
  LoggingFeedbackOperatorAlert,
} from "./operator-alert.js";
import { FeedbackOutboxDispatchProcessor } from "./outbox/dispatch.processor.js";
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
import { PostEventFeedbackExtractionModel } from "../../integrations/llm/feedback-extraction-model.service.js";
import { PostEventFeedbackExtractor } from "./extraction/extract.service.js";
import { FeedbackExtractionAdmissionService } from "./extraction/extraction-admission.service.js";
import { FeedbackModelContextBuilder } from "./extraction/model-context.service.js";
import { FeedbackAiTurnAnalysis } from "./extraction/ai-turn-analysis.service.js";
import { FeedbackParticipantReplyPlanner } from "./extraction/participant-reply.service.js";
import { FeedbackExtractionResultsWriter } from "./extraction/extraction-results-writer.service.js";
import { FeedbackExtractionStateApplier } from "./extraction/extraction-state.service.js";
import { FeedbackExtractionCapacityService } from "./extraction/extraction-capacity.service.js";
import { FeedbackExtractionGuards } from "./extraction/extraction-guards.service.js";
import { FeedbackExtractionTurnService } from "./extraction/extraction-turn.service.js";
import { FeedbackExtractionCommitService } from "./extraction/extraction-commit.service.js";
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
import { FeedbackConversationInactivityService } from "./reconciliation/conversation-inactivity.service.js";
import { FeedbackConversationReconcileService } from "./reconciliation/reconcile.service.js";
import { FeedbackConversationReconcileProcessor } from "./reconciliation/reconcile.processor.js";

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
 * reconciliation, campaign summaries, one maintenance repair pass and
 * recurring PostgreSQL outbox batch dispatch. BullMQ schedules the batch
 * polls; PostgreSQL retains conversation and delivery state. V1 feedback
 * consumers remain only to drain jobs created before the reader-first cutover.
 *
 * `EventsCoreModule` is imported for one reason: extraction selects candidates
 * live through `EventsService.listFeedbackCandidatesForRespondent`, the single
 * D16 helper shared with prompt building and subject validation. This module
 * must never grow a second candidate query of its own.
 *
 * The model provider and the transport adapter both live here, so the HTTP
 * process holds neither a provider client nor a sender for this feature. The
 * two halves meet only through `message_outbox`: extraction inserts a row and
 * the batch dispatcher token-claims it.
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
    FeedbackCampaignSummaryModel,
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
    FeedbackConversationInactivityService,
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
    FeedbackExtractionGuards,
    FeedbackExtractionAdmissionService,
    FeedbackModelContextBuilder,
    FeedbackAiTurnAnalysis,
    FeedbackParticipantReplyPlanner,
    FeedbackExtractionResultsWriter,
    FeedbackExtractionStateApplier,
    FeedbackExtractionCapacityService,
    FeedbackExtractionTurnService,
    FeedbackExtractionCommitService,
    PostEventFeedbackExtractor,
    FeedbackMaterializeWakeupService,
    PendingFeedbackIngressService,
    FeedbackStopService,
    FeedbackInboundMessageService,
    FeedbackClosedConversationIngressService,
    FeedbackObservedOutboundService,
    PostEventFeedbackMaterializer,
    FeedbackMaterializationLimiter,
    PostEventFeedbackMaterializationCoordinator,
    PostEventFeedbackMetrics,
    FeedbackDispatchSettlementService,
    FeedbackDispatchPreparationService,
    FeedbackDispatchRecoveryService,
    FeedbackDispatchAttemptService,
    MessageOutboxDispatcherService,
    FeedbackOutboxDispatchProcessor,
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
