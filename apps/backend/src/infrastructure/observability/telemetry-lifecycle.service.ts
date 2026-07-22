import { Injectable, type OnApplicationShutdown } from "@nestjs/common";

import { shutdownTelemetry } from "../../instrumentation.js";

@Injectable()
export class TelemetryLifecycleService implements OnApplicationShutdown {
  async onApplicationShutdown(): Promise<void> {
    await shutdownTelemetry();
  }
}
