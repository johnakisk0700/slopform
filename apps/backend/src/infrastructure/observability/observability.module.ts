import { Module, type OnApplicationShutdown } from "@nestjs/common";

import { shutdownTelemetry } from "../../instrumentation.js";

@Module({})
export class ObservabilityModule implements OnApplicationShutdown {
  onApplicationShutdown(): Promise<void> {
    return shutdownTelemetry();
  }
}
