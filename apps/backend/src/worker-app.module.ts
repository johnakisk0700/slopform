import { Module } from "@nestjs/common";
import { ConditionalModule } from "@nestjs/config";

import { AppConfigModule } from "./infrastructure/config/app-config.module.js";
import { ProviderCallLimiterModule } from "./infrastructure/ai/provider-call-limiter.module.js";
import { isWasenderTransportEnabled } from "./infrastructure/config/enabled-modules.js";
import { LoggingModule } from "./infrastructure/logging/logging.module.js";
import { ObservabilityModule } from "./infrastructure/observability/observability.module.js";
import { WasenderClientModule } from "./integrations/wasender/wasender-client.module.js";
import { AssistantWorkerModule } from "./modules/assistant/assistant-worker.module.js";
import { EmailWorkerModule } from "./modules/email/email-worker.module.js";
import { PostEventFeedbackWorkerModule } from "./modules/post-event-feedback/worker.module.js";
import { ReferenceWorkerModule } from "./modules/reference/reference-worker.module.js";

@Module({
  imports: [
    AppConfigModule,
    ProviderCallLimiterModule,
    LoggingModule,
    ObservabilityModule,
    ConditionalModule.registerWhen(
      WasenderClientModule,
      isWasenderTransportEnabled,
    ),
    AssistantWorkerModule,
    EmailWorkerModule,
    PostEventFeedbackWorkerModule,
    ReferenceWorkerModule,
  ],
})
export class WorkerAppModule {}
