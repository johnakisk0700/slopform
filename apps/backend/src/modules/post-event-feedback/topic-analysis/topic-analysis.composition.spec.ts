import { MODULE_METADATA } from "@nestjs/common/constants.js";
import { describe, expect, it } from "vitest";
import { TopicAnalysisHttpModule } from "./topic-analysis.http.module.js";
import { TopicAnalysisWorkerModule } from "./topic-analysis.worker.module.js";
import { TopicAnalysisController } from "./topic-analysis.controller.js";
import { TopicAnalysisRunner } from "./topic-analysis.runner.js";
import { TopicAnalysisService } from "./topic-analysis.service.js";
import { TopicClusteringClient } from "../../../integrations/topic-clustering/topic-clustering.client.js";
import { OpenRouterEmbeddingsClient } from "../../../integrations/openrouter/openrouter-embeddings.client.js";
describe("topic analysis process ownership", () => {
  it("keeps provider/subprocess work outside HTTP and controllers outside the worker", () => {
    const httpProviders = Reflect.getMetadata(
      MODULE_METADATA.PROVIDERS,
      TopicAnalysisHttpModule,
    );
    const workerProviders = Reflect.getMetadata(
      MODULE_METADATA.PROVIDERS,
      TopicAnalysisWorkerModule,
    );
    expect(httpProviders).toContain(TopicAnalysisService);
    for (const provider of [
      TopicAnalysisRunner,
      TopicClusteringClient,
      OpenRouterEmbeddingsClient,
    ]) {
      expect(workerProviders).toContain(provider);
      expect(httpProviders).not.toContain(provider);
    }
    expect(workerProviders).not.toContain(TopicAnalysisService);
    expect(
      Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, TopicAnalysisHttpModule),
    ).toEqual([TopicAnalysisController]);
    expect(
      Reflect.getMetadata(
        MODULE_METADATA.CONTROLLERS,
        TopicAnalysisWorkerModule,
      ),
    ).toBeUndefined();
  });
});
