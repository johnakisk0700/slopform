import { MODULE_METADATA } from "@nestjs/common/constants.js";
import { describe, expect, it } from "vitest";

import {
  QueueModule,
  QueueWorkerModule,
} from "../../infrastructure/queue/queue.module.js";
import { AssistantHttpModule } from "./assistant-http.module.js";
import { AssistantWorkerModule } from "./assistant-worker.module.js";

describe("AssistantWorkerModule", () => {
  it("contains only the worker queue and core assistant boundaries", () => {
    const imports = Reflect.getMetadata(
      MODULE_METADATA.IMPORTS,
      AssistantWorkerModule,
    ) as readonly unknown[];

    expect(imports).toContain(QueueWorkerModule);
    expect(imports).not.toContain(QueueModule);
    expect(imports).not.toContain(AssistantHttpModule);
  });
});
