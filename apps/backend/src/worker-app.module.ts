import { Module } from "@nestjs/common";

import { AppConfigModule } from "./infrastructure/config/app-config.module.js";
import { DatabaseModule } from "./infrastructure/database/database.module.js";
import { LoggingModule } from "./infrastructure/logging/logging.module.js";
import { ObservabilityModule } from "./infrastructure/observability/observability.module.js";
import { QueueModule } from "./infrastructure/queue/queue.module.js";
import { ReferenceWorkerModule } from "./modules/reference/reference-worker.module.js";

@Module({
  imports: [
    AppConfigModule,
    LoggingModule,
    ObservabilityModule,
    DatabaseModule,
    QueueModule,
    ReferenceWorkerModule,
  ],
})
export class WorkerAppModule {}
