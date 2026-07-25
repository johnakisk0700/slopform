import { Module } from "@nestjs/common";
import { ConditionalModule } from "@nestjs/config";
import { APP_FILTER, APP_INTERCEPTOR, APP_PIPE } from "@nestjs/core";
import { SentryGlobalFilter, SentryModule } from "@sentry/nestjs/setup";
import { createZodValidationPipe, ZodSerializerInterceptor } from "nestjs-zod";

import { AppConfigModule } from "./infrastructure/config/app-config.module.js";
import { AuthModule } from "./infrastructure/auth/auth.module.js";
import { WasenderHttpModule } from "./integrations/wasender/wasender-http.module.js";
import {
  isBullBoardEnabled,
  isReferenceModuleEnabled,
  isWasenderWebhookEnabled,
} from "./infrastructure/config/environment.js";
import { LoggingModule } from "./infrastructure/logging/logging.module.js";
import { ObservabilityModule } from "./infrastructure/observability/observability.module.js";
import { QueueDashboardModule } from "./infrastructure/queue/queue-dashboard.module.js";
import { AssistantHttpModule } from "./modules/assistant/assistant-http.module.js";
import { EmailHttpModule } from "./modules/email/email-http.module.js";
import { EventsHttpModule } from "./modules/events/events-http.module.js";
import { HealthModule } from "./modules/health/health.module.js";
import { ParticipantsHttpModule } from "./modules/participants/participants-http.module.js";
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
    ParticipantsHttpModule,
    ConditionalModule.registerWhen(
      WasenderHttpModule,
      isWasenderWebhookEnabled,
    ),
    ConditionalModule.registerWhen(QueueDashboardModule, isBullBoardEnabled),
    ConditionalModule.registerWhen(
      ReferenceHttpModule,
      isReferenceModuleEnabled,
    ),
  ],
  providers: [
    { provide: APP_INTERCEPTOR, useClass: ZodSerializerInterceptor },
    { provide: APP_PIPE, useClass: StrictZodValidationPipe },
    { provide: APP_FILTER, useClass: SentryGlobalFilter },
  ],
})
export class HttpAppModule {}
