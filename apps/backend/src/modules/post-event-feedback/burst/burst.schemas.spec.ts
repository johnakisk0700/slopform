import { describe, expect, it } from "vitest";
import { BURST_CAMPAIGNS } from "./burst-scenario.js";
import { feedbackBurstAccountingQuerySchema } from "./burst.schemas.js";

describe("feedback burst accounting schemas", () => {
  it("normalizes one campaign id", () => {
    const campaignId = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

    expect(feedbackBurstAccountingQuerySchema.parse({ campaignId })).toEqual({
      campaignId: [campaignId],
    });
  });

  it("rejects a missing or unbounded campaign scope", () => {
    expect(() => feedbackBurstAccountingQuerySchema.parse({})).toThrow();
    expect(() =>
      feedbackBurstAccountingQuerySchema.parse({
        campaignId: Array.from(
          { length: BURST_CAMPAIGNS.length + 1 },
          () => "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
        ),
      }),
    ).toThrow();
  });
});
