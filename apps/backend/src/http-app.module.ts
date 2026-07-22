import { Module } from "@nestjs/common";
import { ConditionalModule } from "@nestjs/config";
import { APP_FILTER, APP_INTERCEPTOR, APP_PIPE } from "@nestjs/core";
import { SentryGlobalFilter, SentryModule } from "@sentry/nestjs/setup";
import { createZodValidationPipe, ZodSerializerInterceptor } from "nestjs-zod";

import { AppConfigModule } from "./infrastructure/config/app-config.module.js";
import {
  isBullBoardEnabled,
  isReferenceModuleEnabled,
} from "./infrastructure/config/environment.js";
import { LoggingModule } from "./infrastructure/logging/logging.module.js";
import { ObservabilityModule } from "./infrastructure/observability/observability.module.js";
import { QueueDashboardModule } from "./infrastructure/queue/queue-dashboard.module.js";
import { HealthModule } from "./modules/health/health.module.js";
import { ReferenceHttpModule } from "./modules/reference/reference-http.module.js";

const StrictZodValidationPipe = createZodValidationPipe({
  strictSchemaDeclaration: true,
});

@Module({
  imports: [
    AppConfigModule,
    LoggingModule,
    ObservabilityModule,
    SentryModule.forRoot(),
    HealthModule,
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
