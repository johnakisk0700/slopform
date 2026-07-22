import { MODULE_METADATA } from "@nestjs/common/constants.js";
import { describe, expect, it } from "vitest";

import {
  QueueModule,
  QueueWorkerModule,
} from "../../infrastructure/queue/queue.module.js";
import { ReferenceWorkerModule } from "./reference-worker.module.js";

describe("ReferenceWorkerModule", () => {
  it("imports the worker queue boundary rather than the HTTP producer module", () => {
    const imports = Reflect.getMetadata(
      MODULE_METADATA.IMPORTS,
      ReferenceWorkerModule,
    ) as readonly unknown[];

    expect(imports).toContain(QueueWorkerModule);
    expect(imports).not.toContain(QueueModule);
  });
});
