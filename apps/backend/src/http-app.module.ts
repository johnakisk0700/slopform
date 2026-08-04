import { Module } from "@nestjs/common";
import { ConditionalModule } from "@nestjs/config";
import { APP_FILTER, APP_INTERCEPTOR, APP_PIPE } from "@nestjs/core";
import { SentryGlobalFilter, SentryModule } from "@sentry/nestjs/setup";
import { createZodValidationPipe, ZodSerializerInterceptor } from "nestjs-zod";

import { AppConfigModule } from "./infrastructure/config/app-config.module.js";
import { AuthModule } from "./infrastructure/auth/auth.module.js";
import {
  isBullBoardEnabled,
  isFeedbackSimulatorHttpEnabled,
  isReferenceModuleEnabled,
  isWasenderWebhookEnabled,
} from "./infrastructure/config/enabled-modules.js";
import { LoggingModule } from "./infrastructure/logging/logging.module.js";
import { ObservabilityModule } from "./infrastructure/observability/observability.module.js";
import { QueueDashboardModule } from "./infrastructure/queue/queue-dashboard.module.js";
import { AssistantHttpModule } from "./modules/assistant/assistant-http.module.js";
import { EmailHttpModule } from "./modules/email/email-http.module.js";
import { EventsHttpModule } from "./modules/events/events-http.module.js";
import { HealthModule } from "./modules/health/health.module.js";
import { OverviewHttpModule } from "./modules/overview/overview-http.module.js";
import { ParticipantsHttpModule } from "./modules/participants/participants-http.module.js";
import { PostEventFeedbackCoreModule } from "./modules/post-event-feedback/core.module.js";
import { PostEventFeedbackHttpModule } from "./modules/post-event-feedback/http.module.js";
import { WasenderWebhookModule } from "./modules/post-event-feedback/ingress/wasender-webhook.module.js";
import { PostEventFeedbackBurstHttpModule } from "./modules/post-event-feedback/burst/http.module.js";
import { PostEventFeedbackSimulatorHttpModule } from "./modules/post-event-feedback/simulator/http.module.js";
import { ReferenceHttpModule } from "./modules/reference/reference-http.module.js";

const StrictZodValidationPipe = createZodValidationPipe({
  strictSchemaDeclaration: true,
});

@Module({
  imports: [
    AppConfigModule,
    AuthModule,
    LoggingModule,
    ObservabilityModule,
    SentryModule.forRoot(),
    HealthModule,
    AssistantHttpModule,
    EmailHttpModule,
    EventsHttpModule,
    OverviewHttpModule,
    ParticipantsHttpModule,
    PostEventFeedbackCoreModule,
    PostEventFeedbackHttpModule,
    ConditionalModule.registerWhen(
      WasenderWebhookModule,
      isWasenderWebhookEnabled,
    ),
    ConditionalModule.registerWhen(QueueDashboardModule, isBullBoardEnabled),
    ConditionalModule.registerWhen(
      ReferenceHttpModule,
      isReferenceModuleEnabled,
    ),
    ConditionalModule.registerWhen(
      PostEventFeedbackSimulatorHttpModule,
      isFeedbackSimulatorHttpEnabled,
    ),
    ConditionalModule.registerWhen(
      PostEventFeedbackBurstHttpModule,
      isFeedbackSimulatorHttpEnabled,
    ),
  ],
  providers: [
    { provide: APP_INTERCEPTOR, useClass: ZodSerializerInterceptor },
    { provide: APP_PIPE, useClass: StrictZodValidationPipe },
    { provide: APP_FILTER, useClass: SentryGlobalFilter },
  ],
})
export class HttpAppModule {}
