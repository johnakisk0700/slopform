import { Module } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { SentryModule, SentryGlobalFilter } from "@sentry/nestjs/setup";

import { TelemetryLifecycleService } from "./telemetry-lifecycle.service.js";

@Module({
  imports: [SentryModule.forRoot()],
  providers: [
    TelemetryLifecycleService,
    {
      provide: APP_FILTER,
      useClass: SentryGlobalFilter,
    },
  ],
})
export class ObservabilityModule {}
