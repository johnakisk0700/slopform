import { Module } from "@nestjs/common";
import { APP_INTERCEPTOR, APP_PIPE } from "@nestjs/core";
import { createZodValidationPipe, ZodSerializerInterceptor } from "nestjs-zod";

import { AppConfigModule } from "./infrastructure/config/app-config.module.js";
import { DatabaseModule } from "./infrastructure/database/database.module.js";
import { LoggingModule } from "./infrastructure/logging/logging.module.js";
import { ObservabilityModule } from "./infrastructure/observability/observability.module.js";
import { QueueDashboardModule } from "./infrastructure/queue/queue-dashboard.module.js";
import { QueueModule } from "./infrastructure/queue/queue.module.js";
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
    DatabaseModule,
    QueueModule,
    QueueDashboardModule,
    HealthModule,
    ReferenceHttpModule,
  ],
  providers: [
    { provide: APP_PIPE, useClass: StrictZodValidationPipe },
    { provide: APP_INTERCEPTOR, useClass: ZodSerializerInterceptor },
  ],
})
export class HttpAppModule {}
