import { describe, expect, it } from "vitest";

import { ObservabilityModule } from "./observability.module.js";

describe("ObservabilityModule", () => {
  it("coalesces repeated shutdown calls", async () => {
    const module = new ObservabilityModule();
    const first = module.onApplicationShutdown();
    const second = module.onApplicationShutdown();

    expect(first).toBe(second);
    await expect(first).resolves.toBeUndefined();
  });
});
