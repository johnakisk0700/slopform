import { Module } from "@nestjs/common";

import { TelemetryLifecycleService } from "./telemetry-lifecycle.service.js";

@Module({
  providers: [TelemetryLifecycleService],
})
export class ObservabilityModule {}
