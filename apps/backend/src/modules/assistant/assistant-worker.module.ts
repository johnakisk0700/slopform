import { Module } from "@nestjs/common";

import { AuditModule } from "../../infrastructure/audit/audit.module.js";
import { DatabaseModule } from "../../infrastructure/database/database.module.js";
import { QueueWorkerModule } from "../../infrastructure/queue/queue.module.js";
import { EventsCoreModule } from "../events/events-core.module.js";
import { ParticipantsCoreModule } from "../participants/participants-core.module.js";
import { PostEventFeedbackCoreModule } from "../post-event-feedback/core.module.js";
import { FeedbackCampaignResumeRepairService } from "../post-event-feedback/campaign/resume-repair.service.js";
import { PostEventFeedbackCampaignService } from "../post-event-feedback/campaign/campaign.service.js";
import { PostEventFeedbackConversationService } from "../post-event-feedback/inbox/conversation.service.js";
import { FeedbackOutboundTranscriptService } from "../post-event-feedback/outbox/outbound-transcript.service.js";
import { FeedbackConversationWakeupService } from "../post-event-feedback/reconciliation/wakeup.service.js";
import { PostEventFeedbackCampaignSummaryService } from "../post-event-feedback/summary/summary.service.js";
import { AssistantGenerationService } from "./assistant-generation.service.js";
import { AssistantRecoveryService } from "./assistant-recovery.service.js";
import { AssistantCoreModule } from "./assistant-core.module.js";
import { AssistantStreamRelay } from "./assistant-stream.relay.js";
import { AssistantProcessor } from "./assistant.processor.js";
import { AssistantToolsService } from "./tools/assistant-tools.service.js";

@Module({
  imports: [
    QueueWorkerModule,
    AssistantCoreModule,
    // The tool set reads the domain in-process rather than over HTTP: the
    // worker holds no session, and a loopback call would only re-authenticate
    // a principal this process already trusts.
    AuditModule,
    DatabaseModule,
    EventsCoreModule,
    ParticipantsCoreModule,
    PostEventFeedbackCoreModule,
  ],
  providers: [
    AssistantGenerationService,
    AssistantProcessor,
    AssistantRecoveryService,
    AssistantStreamRelay,
    AssistantToolsService,
    /**
     * The feedback read services are declared here rather than imported from
     * `PostEventFeedbackHttpModule`, which is where the HTTP process gets them.
     * That module carries four controllers, and a worker has no business
     * mounting routes it will never serve. `PostEventFeedbackWorkerModule`
     * already declares the summary service exactly this way, so this follows a
     * path the worker topology has taken before rather than inventing one.
     */
    FeedbackOutboundTranscriptService,
    FeedbackConversationWakeupService,
    FeedbackCampaignResumeRepairService,
    PostEventFeedbackCampaignService,
    PostEventFeedbackConversationService,
    PostEventFeedbackCampaignSummaryService,
  ],
})
export class AssistantWorkerModule {}
