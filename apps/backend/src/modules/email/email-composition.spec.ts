import { MODULE_METADATA } from "@nestjs/common/constants.js";
import { describe, expect, it } from "vitest";

import {
  QueueModule,
  QueueWorkerModule,
} from "../../infrastructure/queue/queue.module.js";
import { EmailHttpModule } from "./email-http.module.js";
import { EmailWorkerModule } from "./email-worker.module.js";

describe("email process composition", () => {
  it("keeps HTTP and worker adapters in separate app graphs", async () => {
    process.env.DATABASE_URL ??=
      "postgresql://user:password@127.0.0.1:5432/join_the_six_test";
    const [httpApp, workerApp] = await Promise.all([
      import("../../http-app.module.js"),
      import("../../worker-app.module.js"),
    ]);
    const httpImports = Reflect.getMetadata(
      MODULE_METADATA.IMPORTS,
      httpApp.HttpAppModule,
    ) as readonly unknown[];
    const workerImports = Reflect.getMetadata(
      MODULE_METADATA.IMPORTS,
      workerApp.WorkerAppModule,
    ) as readonly unknown[];

    expect(httpImports).toContain(EmailHttpModule);
    expect(httpImports).not.toContain(EmailWorkerModule);
    expect(workerImports).toContain(EmailWorkerModule);
    expect(workerImports).not.toContain(EmailHttpModule);
  });

  it("uses the worker queue registration for the worker-side outbox relay", () => {
    const imports = Reflect.getMetadata(
      MODULE_METADATA.IMPORTS,
      EmailWorkerModule,
    ) as readonly unknown[];
    expect(imports).toContain(QueueWorkerModule);
    expect(imports).not.toContain(QueueModule);
  });
});
