import { randomUUID } from "node:crypto";

import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import type { Environment } from "../../../infrastructure/config/environment.js";
import {
  resolveFeedbackSimulatedTransportProfile,
  type FeedbackSimulatedTransportProfile,
} from "../../../infrastructure/config/feedback-simulated-transport.js";

import type {
  FeedbackTransport,
  FeedbackTransportSendInput,
  FeedbackTransportSendResult,
} from "./transport.js";
import { decideFeedbackSimulatedTransport } from "./simulated-transport-faults.js";
import { FeedbackSimOutboundRepository } from "../simulator/sim-outbound.repository.js";

/**
 * Durable PostgreSQL outbound sink for `TRANSPORT_MODE=simulated` (WP8).
 *
 * Rows live in `feedback_sim_outbound` and are queryable per phone for the admin
 * simulator thread. Production can select this adapter only through the
 * explicit rehearsal gate; no provider client is involved.
 */
@Injectable()
export class SimulatedFeedbackTransport implements FeedbackTransport {
  private readonly logger = new Logger(SimulatedFeedbackTransport.name);
  private readonly profile: FeedbackSimulatedTransportProfile;

  constructor(
    private readonly repository: FeedbackSimOutboundRepository,
    config: ConfigService<Environment, true>,
  ) {
    this.profile = resolveFeedbackSimulatedTransportProfile({
      faultMode: config.get("FEEDBACK_SIMULATED_TRANSPORT_FAULT_MODE", {
        infer: true,
      }),
      faultPercent: config.get("FEEDBACK_SIMULATED_TRANSPORT_FAULT_PERCENT", {
        infer: true,
      }),
      seed: config.get("FEEDBACK_SIMULATED_TRANSPORT_SEED", { infer: true }),
      maxDelayMs: config.get("FEEDBACK_SIMULATED_TRANSPORT_MAX_DELAY_MS", {
        infer: true,
      }),
    });
  }

  async sendText(
    input: FeedbackTransportSendInput,
  ): Promise<FeedbackTransportSendResult> {
    const decision = decideFeedbackSimulatedTransport(
      this.profile,
      input.outboxId,
    );
    if (decision.delayMs > 0) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, decision.delayMs);
      });
    }

    if (decision.outcome === "rejected") {
      this.logFault(input.outboxId, decision.outcome, decision.delayMs);
      return {
        outcome: "not-accepted",
        reason: "simulated_rejection",
      };
    }
    if (decision.outcome === "rate-limited") {
      this.logFault(input.outboxId, decision.outcome, decision.delayMs);
      return {
        outcome: "not-accepted",
        reason: "simulated_rate_limit",
        retryAfterSeconds: 30,
      };
    }
    if (decision.outcome === "unknown-before-accept") {
      this.logFault(input.outboxId, decision.outcome, decision.delayMs);
      return {
        outcome: "unknown",
        reason: "simulated_unknown_without_acceptance_evidence",
      };
    }

    const id = randomUUID();
    const sentAt = new Date();
    const providerMessageId = `sim-${id}`;

    await this.repository.insertSimOutbound({
      id,
      outboxId: input.outboxId,
      phoneE164: input.to,
      body: input.text,
      providerMessageId,
      sentAt,
    });

    if (decision.outcome === "unknown-after-accept") {
      this.logFault(input.outboxId, decision.outcome, decision.delayMs);
      return {
        outcome: "unknown",
        reason: "simulated_response_lost_after_acceptance",
        providerLogId: id,
      };
    }

    this.logger.log({
      event: "feedback.transport.simulated.sent",
      outboxId: input.outboxId,
      simulatedDelayMs: decision.delayMs,
      // Recipient and body are intentionally omitted from logs.
    });

    return {
      outcome: "accepted",
      providerLogId: id,
      providerMessageId,
      providerStatus: "simulated",
    };
  }

  private logFault(
    outboxId: string,
    outcome: Exclude<
      ReturnType<typeof decideFeedbackSimulatedTransport>["outcome"],
      "accepted"
    >,
    delayMs: number,
  ): void {
    this.logger.warn({
      event: "feedback.transport.simulated.fault",
      outboxId,
      simulatedOutcome: outcome,
      simulatedDelayMs: delayMs,
      // Seed, recipient and body are intentionally omitted from logs.
    });
  }
}
