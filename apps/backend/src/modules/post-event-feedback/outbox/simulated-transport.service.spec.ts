import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { ConfigService } from "@nestjs/config";

import type { Environment } from "../../../infrastructure/config/environment.js";

import type { FeedbackSimOutboundRepository } from "../simulator/sim-outbound.repository.js";
import { decideFeedbackSimulatedTransport } from "./simulated-transport-faults.js";
import { SimulatedFeedbackTransport } from "./simulated-transport.service.js";

describe("SimulatedFeedbackTransport", () => {
  it("persists outbound sends for later sim-thread reads", async () => {
    const outboxId = randomUUID();
    const repository = repositoryDouble();
    const transport = createTransport(repository);
    const result = await transport.sendText({
      to: "+306900000001",
      text: "Γεια!",
      outboxId,
    });

    expect(result).toMatchObject({
      outcome: "accepted",
      providerStatus: "simulated",
      providerMessageId: expect.stringMatching(/^sim-/),
    });
    expect(repository.insertSimOutbound).toHaveBeenCalledWith(
      expect.objectContaining({
        outboxId,
        phoneE164: "+306900000001",
        body: "Γεια!",
      }),
    );
  });

  it.each([
    ["reject", "not-accepted", "simulated_rejection"],
    ["rate-limit", "not-accepted", "simulated_rate_limit"],
    [
      "unknown-before-accept",
      "unknown",
      "simulated_unknown_without_acceptance_evidence",
    ],
  ] as const)(
    "returns a %s fault without fabricating simulated acceptance",
    async (faultMode, outcome, reason) => {
      const repository = repositoryDouble();
      const transport = createTransport(repository, {
        FEEDBACK_SIMULATED_TRANSPORT_FAULT_MODE: faultMode,
        FEEDBACK_SIMULATED_TRANSPORT_FAULT_PERCENT: 100,
      });

      const result = await transport.sendText({
        to: "+306900000001",
        text: "Γεια!",
        outboxId: randomUUID(),
      });
      expect(result).toMatchObject({ outcome, reason });
      if (faultMode === "rate-limit") {
        expect(result).toMatchObject({ retryAfterSeconds: 30 });
      }
      expect(repository.insertSimOutbound).not.toHaveBeenCalled();
    },
  );

  it("models a lost response after provider acceptance without claiming certainty", async () => {
    const repository = repositoryDouble();
    const transport = createTransport(repository, {
      FEEDBACK_SIMULATED_TRANSPORT_FAULT_MODE: "unknown-after-accept",
      FEEDBACK_SIMULATED_TRANSPORT_FAULT_PERCENT: 100,
    });

    const result = await transport.sendText({
      to: "+306900000001",
      text: "Γεια!",
      outboxId: randomUUID(),
    });

    expect(repository.insertSimOutbound).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      outcome: "unknown",
      reason: "simulated_response_lost_after_acceptance",
      providerLogId: expect.any(String),
    });
  });

  it("waits the stable configured provider latency before acceptance", async () => {
    vi.useFakeTimers();
    try {
      const outboxId = "11111111-1111-4111-8111-111111111111";
      const profile = {
        faultMode: "none",
        faultPercent: 0,
        seed: "latency-1",
        maxDelayMs: 10_000,
      } as const;
      const delayMs = decideFeedbackSimulatedTransport(
        profile,
        outboxId,
      ).delayMs;
      expect(delayMs).toBeGreaterThan(0);
      const repository = repositoryDouble();
      const transport = createTransport(repository, {
        FEEDBACK_SIMULATED_TRANSPORT_SEED: profile.seed,
        FEEDBACK_SIMULATED_TRANSPORT_MAX_DELAY_MS: profile.maxDelayMs,
      });

      const result = transport.sendText({
        to: "+306900000001",
        text: "Γεια!",
        outboxId,
      });
      expect(repository.insertSimOutbound).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(delayMs - 1);
      expect(repository.insertSimOutbound).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await expect(result).resolves.toMatchObject({ outcome: "accepted" });
    } finally {
      vi.useRealTimers();
    }
  });
});

function createTransport(
  repository: FeedbackSimOutboundRepository,
  environment: Partial<Environment> = {},
): SimulatedFeedbackTransport {
  const defaults: Partial<Environment> = {
    FEEDBACK_SIMULATED_TRANSPORT_FAULT_MODE: "none",
    FEEDBACK_SIMULATED_TRANSPORT_FAULT_PERCENT: 0,
    FEEDBACK_SIMULATED_TRANSPORT_SEED: "1",
    FEEDBACK_SIMULATED_TRANSPORT_MAX_DELAY_MS: 0,
  };
  const config = {
    get: vi.fn((key: keyof Environment) => environment[key] ?? defaults[key]),
  } as unknown as ConfigService<Environment, true>;
  return new SimulatedFeedbackTransport(repository, config);
}

function repositoryDouble(): FeedbackSimOutboundRepository {
  return {
    insertSimOutbound: vi.fn(async (input) => ({
      id: input.id ?? randomUUID(),
      createdAt: new Date(),
      ...input,
    })),
  } as unknown as FeedbackSimOutboundRepository;
}
