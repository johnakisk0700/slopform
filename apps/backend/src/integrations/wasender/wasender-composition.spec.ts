import { MODULE_METADATA } from "@nestjs/common/constants.js";
import { describe, expect, it } from "vitest";

import { WasenderClient } from "./wasender.client.js";
import { WasenderHttpModule } from "./wasender-http.module.js";
import { WasenderTransportModule } from "./wasender-transport.module.js";

describe("Wasender process composition", () => {
  it("keeps provider egress separate from the public webhook module", () => {
    const transportExports = Reflect.getMetadata(
      MODULE_METADATA.EXPORTS,
      WasenderTransportModule,
    ) as readonly unknown[];
    const transportControllers = Reflect.getMetadata(
      MODULE_METADATA.CONTROLLERS,
      WasenderTransportModule,
    ) as readonly unknown[] | undefined;
    const httpExports = Reflect.getMetadata(
      MODULE_METADATA.EXPORTS,
      WasenderHttpModule,
    ) as readonly unknown[];

    expect(transportExports).toContain(WasenderClient);
    expect(transportControllers ?? []).toEqual([]);
    expect(httpExports).not.toContain(WasenderClient);
  });
});
