import { Module } from "@nestjs/common";
import { AuditModule } from "../../../infrastructure/audit/audit.module.js";
import { DatabaseModule } from "../../../infrastructure/database/database.module.js";
import { QueueModule } from "../../../infrastructure/queue/queue.module.js";
import { TopicAnalysisController } from "./topic-analysis.controller.js";
import { TopicAnalysisRepository } from "./topic-analysis.repository.js";
import { TopicAnalysisService } from "./topic-analysis.service.js";
import { TopicAnalysisWakeup } from "./topic-analysis.wakeup.js";

@Module({
  imports: [AuditModule, DatabaseModule, QueueModule],
  controllers: [TopicAnalysisController],
  providers: [
    TopicAnalysisRepository,
    TopicAnalysisService,
    TopicAnalysisWakeup,
  ],
})
export class TopicAnalysisHttpModule {}
