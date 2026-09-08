import { describe, expect, it } from "vitest";
import { IS_PUBLIC_ROUTE } from "../../infrastructure/auth/public.decorator.js";
import { isFeedbackSimulatorHttpEnabled } from "../../infrastructure/config/enabled-modules.js";
import { FeedbackBurstController } from "./burst/burst.controller.js";
import { DisabledFeedbackTransport } from "./outbox/disabled-transport.service.js";
import type { SimulatedFeedbackTransport } from "./outbox/simulated-transport.service.js";
import { FeedbackSimulatorController } from "./simulator/simulator.controller.js";
import { createFeedbackTransport } from "./worker.module.js";

describe("post-event feedback process composition", () => {
  it("keeps production simulator composition fail-closed without its rehearsal gate", () => {
    expect(
      isFeedbackSimulatorHttpEnabled({
        NODE_ENV: "production",
        FEEDBACK_SIMULATOR_ENABLED: "true",
        TRANSPORT_MODE: "simulated",
      }),
    ).toBe(false);
    expect(
      isFeedbackSimulatorHttpEnabled({
        NODE_ENV: "development",
        FEEDBACK_SIMULATOR_ENABLED: "false",
        TRANSPORT_MODE: "simulated",
      }),
    ).toBe(false);
    expect(
      isFeedbackSimulatorHttpEnabled({
        NODE_ENV: "development",
        FEEDBACK_SIMULATOR_ENABLED: "true",
        TRANSPORT_MODE: "wasender",
      }),
    ).toBe(false);
    expect(
      isFeedbackSimulatorHttpEnabled({
        NODE_ENV: "development",
        FEEDBACK_SIMULATOR_ENABLED: "true",
        TRANSPORT_MODE: "simulated",
      }),
    ).toBe(true);
    expect(
      isFeedbackSimulatorHttpEnabled({
        NODE_ENV: "production",
        FEEDBACK_PRODUCTION_REHEARSAL_ENABLED: "true",
        FEEDBACK_SIMULATOR_ENABLED: "true",
        TRANSPORT_MODE: "simulated",
      }),
    ).toBe(true);
  });

  it("keeps the production rehearsal simulator behind the global Clerk guard", () => {
    expect(
      Reflect.getMetadata(IS_PUBLIC_ROUTE, FeedbackSimulatorController),
    ).not.toBe(true);
    expect(
      Reflect.getMetadata(IS_PUBLIC_ROUTE, FeedbackBurstController),
    ).not.toBe(true);
    expect(
      Reflect.getMetadata(
        IS_PUBLIC_ROUTE,
        FeedbackBurstController.prototype.getCatalog,
      ),
    ).not.toBe(true);

    for (const method of [
      "getCatalog",
      "preflightRun",
      "startRun",
      "getRun",
      "inject",
      "getThread",
    ] as const) {
      expect(
        Reflect.getMetadata(
          IS_PUBLIC_ROUTE,
          FeedbackSimulatorController.prototype[method],
        ),
      ).not.toBe(true);
    }
  });

  it("selects a provider-free disabled transport and enforces Wasender credentials in the worker", () => {
    const disabled = new DisabledFeedbackTransport();
    const simulated = {} as SimulatedFeedbackTransport;
    expect(() =>
      createFeedbackTransport("wasender", undefined, simulated, disabled),
    ).toThrow(/WASENDER_SESSION_API_KEY is required/);
  });
});
