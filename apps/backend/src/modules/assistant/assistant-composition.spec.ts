import { MODULE_METADATA } from "@nestjs/common/constants.js";
import { describe, expect, it } from "vitest";

describe("assistant process composition", () => {
  it("keeps the HTTP producer and worker processor in separate app graphs", async () => {
    process.env.DATABASE_URL ??=
      "postgresql://user:password@127.0.0.1:5432/join_the_six_test";
    process.env.MONGODB_URI ??= "mongodb://127.0.0.1:27017/join_the_six_test";
    const [httpApp, workerApp, assistantHttp, assistantWorker] =
      await Promise.all([
        import("../../http-app.module.js"),
        import("../../worker-app.module.js"),
        import("./assistant-http.module.js"),
        import("./assistant-worker.module.js"),
      ]);
    const httpImports = Reflect.getMetadata(
      MODULE_METADATA.IMPORTS,
      httpApp.HttpAppModule,
    ) as readonly unknown[];
    const workerImports = Reflect.getMetadata(
      MODULE_METADATA.IMPORTS,
      workerApp.WorkerAppModule,
    ) as readonly unknown[];

    expect(httpImports).toContain(assistantHttp.AssistantHttpModule);
    expect(httpImports).not.toContain(assistantWorker.AssistantWorkerModule);
    expect(workerImports).toContain(assistantWorker.AssistantWorkerModule);
    expect(workerImports).not.toContain(assistantHttp.AssistantHttpModule);
  }, 15_000);
});
