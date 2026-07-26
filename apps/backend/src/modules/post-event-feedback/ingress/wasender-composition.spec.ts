import { MODULE_METADATA } from "@nestjs/common/constants.js";
import { describe, expect, it } from "vitest";

import { WasenderClient } from "../../../integrations/wasender/wasender.client.js";
import { WasenderClientModule } from "../../../integrations/wasender/wasender-client.module.js";
import { WasenderWebhookModule } from "./wasender-webhook.module.js";

describe("Wasender process composition", () => {
  it("keeps provider egress separate from the public webhook module", () => {
    const transportExports = Reflect.getMetadata(
      MODULE_METADATA.EXPORTS,
      WasenderClientModule,
    ) as readonly unknown[];
    const transportControllers = Reflect.getMetadata(
      MODULE_METADATA.CONTROLLERS,
      WasenderClientModule,
    ) as readonly unknown[] | undefined;
    const httpExports = Reflect.getMetadata(
      MODULE_METADATA.EXPORTS,
      WasenderWebhookModule,
    ) as readonly unknown[];

    expect(transportExports).toContain(WasenderClient);
    expect(transportControllers ?? []).toEqual([]);
    expect(httpExports).not.toContain(WasenderClient);
  });
});
