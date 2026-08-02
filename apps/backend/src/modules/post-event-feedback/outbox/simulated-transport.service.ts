import { randomUUID } from "node:crypto";

import { Injectable, Logger } from "@nestjs/common";

import type {
  FeedbackTransport,
  FeedbackTransportMessageInfo,
  FeedbackTransportSendInput,
  FeedbackTransportSendResult,
} from "./transport.js";
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

  constructor(private readonly repository: FeedbackSimOutboundRepository) {}

  async sendText(
    input: FeedbackTransportSendInput,
  ): Promise<FeedbackTransportSendResult> {
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

    this.logger.log({
      event: "feedback.transport.simulated.sent",
      outboxId: input.outboxId,
      // Recipient and body are intentionally omitted from logs.
    });

    return {
      outcome: "accepted",
      providerLogId: id,
      providerMessageId,
      providerStatus: "simulated",
    };
  }

  async getMessageInfo(
    providerLogId: string,
  ): Promise<FeedbackTransportMessageInfo | undefined> {
    const message = await this.repository.findSimOutboundById(providerLogId);
    if (!message) {
      return undefined;
    }

    return {
      providerLogId: message.id,
      providerMessageId: message.providerMessageId,
      status: "sent",
      occurredAt: message.sentAt,
    };
  }
}
