import { describe, expect, it } from "vitest";

import { injectFeedbackSimulatorMessageSchema } from "./simulator.schemas.js";

describe("injectFeedbackSimulatorMessageSchema", () => {
  it("accepts a bounded log-safe idempotency key", () => {
    expect(
      injectFeedbackSimulatorMessageSchema.parse({
        phoneE164: "+306900000000",
        text: "Ήταν ωραία.",
        idempotencyKey: `burst-${"a".repeat(64)}`,
      }),
    ).toMatchObject({
      fromMe: false,
      idempotencyKey: `burst-${"a".repeat(64)}`,
    });
  });

  it("rejects unsafe or oversized idempotency keys", () => {
    expect(() =>
      injectFeedbackSimulatorMessageSchema.parse({
        phoneE164: "+306900000000",
        text: "Ήταν ωραία.",
        idempotencyKey: "contains spaces",
      }),
    ).toThrow();
    expect(() =>
      injectFeedbackSimulatorMessageSchema.parse({
        phoneE164: "+306900000000",
        text: "Ήταν ωραία.",
        idempotencyKey: "a".repeat(129),
      }),
    ).toThrow();
  });
});
