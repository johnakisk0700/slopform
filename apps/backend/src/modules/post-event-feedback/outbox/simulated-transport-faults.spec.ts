import { describe, expect, it } from "vitest";

import type { FeedbackSimulatedTransportProfile } from "../../../infrastructure/config/feedback-simulated-transport.js";
import { decideFeedbackSimulatedTransport } from "./simulated-transport-faults.js";

describe("simulated transport fault decisions", () => {
  it.each([
    ["reject", "rejected"],
    ["rate-limit", "rate-limited"],
    ["unknown-before-accept", "unknown-before-accept"],
    ["unknown-after-accept", "unknown-after-accept"],
  ] as const)("applies a 100%% %s treatment", (faultMode, outcome) => {
    expect(
      decideFeedbackSimulatedTransport(
        profile({ faultMode, faultPercent: 100 }),
        "11111111-1111-4111-8111-111111111111",
      ),
    ).toEqual({ outcome, delayMs: 0 });
  });

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

  it("keeps the seeded decision contract stable across releases", () => {
    expect(
      decideFeedbackSimulatedTransport(
        profile({
          faultMode: "mixed",
          faultPercent: 100,
          seed: "golden-1",
          maxDelayMs: 12_345,
        }),
        "11111111-1111-4111-8111-111111111111",
      ),
    ).toEqual({ outcome: "unknown-after-accept", delayMs: 9_241 });
  });

  it("covers every honest mixed provider outcome", () => {
    const outcomes = new Set(
      Array.from({ length: 100 }, (_, index) =>
        decideFeedbackSimulatedTransport(
          profile({ faultMode: "mixed", faultPercent: 100 }),
          `outbox-${index}`,
        ),
      ).map(({ outcome }) => outcome),
    );

    expect(outcomes).toEqual(
      new Set([
        "rejected",
        "rate-limited",
        "unknown-before-accept",
        "unknown-after-accept",
      ]),
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
