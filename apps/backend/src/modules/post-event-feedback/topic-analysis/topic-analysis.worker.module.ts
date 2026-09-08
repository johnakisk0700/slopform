import { Module } from "@nestjs/common";
import { DatabaseModule } from "../../../infrastructure/database/database.module.js";
import { QueueWorkerModule } from "../../../infrastructure/queue/queue.module.js";
import { OpenRouterEmbeddingsClient } from "../../../integrations/openrouter/openrouter-embeddings.client.js";
import { TopicClusteringClient } from "../../../integrations/topic-clustering/topic-clustering.client.js";
import { TopicAnalysisRepository } from "./topic-analysis.repository.js";
import { TopicAnalysisRunner } from "./topic-analysis.runner.js";
import { TopicAnalysisProcessor } from "./topic-analysis.processor.js";
import { TopicAnalysisRecovery } from "./topic-analysis.recovery.js";
import { TopicAnalysisWakeup } from "./topic-analysis.wakeup.js";

@Module({
  imports: [DatabaseModule, QueueWorkerModule],
  providers: [
    TopicAnalysisRepository,
    TopicAnalysisRunner,
    TopicAnalysisProcessor,
    TopicAnalysisRecovery,
    TopicAnalysisWakeup,
    OpenRouterEmbeddingsClient,
    TopicClusteringClient,
  ],
})
export class TopicAnalysisWorkerModule {}
