import { describe, expect, it } from "vitest";

import type { FeedbackSimulatedTransportProfile } from "../../../infrastructure/config/feedback-simulated-transport.js";
import { decideFeedbackSimulatedTransport } from "./simulated-transport-faults.js";

describe("simulated transport fault decisions", () => {
  it("selects a stable subset without process-local random state", () => {
    const treatment = profile({
      faultMode: "reject",
      faultPercent: 50,
      seed: "rehearsal-17",
      maxDelayMs: 5_000,
    });
    const first = Array.from({ length: 50 }, (_, index) =>
      decideFeedbackSimulatedTransport(treatment, `outbox-${index}`),
    );
    const second = Array.from({ length: 50 }, (_, index) =>
      decideFeedbackSimulatedTransport(treatment, `outbox-${index}`),
    );

    expect(second).toEqual(first);
    expect(new Set(first.map(({ outcome }) => outcome))).toEqual(
      new Set(["accepted", "rejected"]),
    );
    expect(first.every(({ delayMs }) => delayMs >= 0 && delayMs <= 5_000)).toBe(
      true,
    );
  });
});

function profile(
  overrides: Partial<FeedbackSimulatedTransportProfile> = {},
): FeedbackSimulatedTransportProfile {
  return {
    faultMode: "none",
    faultPercent: 0,
    seed: "1",
    maxDelayMs: 0,
    ...overrides,
  };
}
