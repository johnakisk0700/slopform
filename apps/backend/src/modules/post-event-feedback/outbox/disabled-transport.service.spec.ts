import { describe, expect, it } from "vitest";

import { DisabledFeedbackTransport } from "./disabled-transport.service.js";

describe("DisabledFeedbackTransport", () => {
  it("rejects every send deterministically without a provider dependency", async () => {
    const transport = new DisabledFeedbackTransport();

    await expect(
      transport.sendText({
        to: "+306900000001",
        text: "Δεν θα σταλεί.",
        outboxId: "66de52a8-1a26-4cbb-b8d1-fcf8bdc2dd51",
      }),
    ).resolves.toEqual({
      outcome: "not-accepted",
      reason: "transport_disabled",
    });
  });
});
