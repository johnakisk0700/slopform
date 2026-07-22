import { Module } from "@nestjs/common";

import { DatabaseModule } from "../../infrastructure/database/database.module.js";
import { QueueModule } from "../../infrastructure/queue/queue.module.js";
import { HealthController } from "./health.controller.js";

@Module({
  imports: [DatabaseModule, QueueModule],
  controllers: [HealthController],
})
export class HealthModule {}
