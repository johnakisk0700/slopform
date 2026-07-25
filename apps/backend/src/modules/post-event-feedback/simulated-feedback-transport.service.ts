import { randomUUID } from "node:crypto";

import { Injectable, Logger } from "@nestjs/common";

import type {
  FeedbackTransport,
  FeedbackTransportMessageInfo,
  FeedbackTransportSendInput,
  FeedbackTransportSendResult,
} from "./feedback-transport.js";

/**
 * Minimal in-memory outbound sink for `TRANSPORT_MODE=simulated`.
 *
 * WP8 replaces this with a durable development sink plus authenticated
 * inject/read endpoints. Do not add HTTP endpoints or durable storage here.
 */
export type SimulatedOutboundMessage = {
  readonly id: string;
  readonly outboxId: string;
  readonly to: string;
  readonly text: string;
  readonly sentAt: Date;
};

@Injectable()
export class SimulatedFeedbackTransport implements FeedbackTransport {
  private readonly logger = new Logger(SimulatedFeedbackTransport.name);
  private readonly messages: SimulatedOutboundMessage[] = [];

  async sendText(
    input: FeedbackTransportSendInput,
  ): Promise<FeedbackTransportSendResult> {
    const id = randomUUID();
    const message: SimulatedOutboundMessage = {
      id,
      outboxId: input.outboxId,
      to: input.to,
      text: input.text,
      sentAt: new Date(),
    };
    this.messages.push(message);

    this.logger.log({
      event: "feedback.transport.simulated.sent",
      outboxId: input.outboxId,
      // Recipient and body are intentionally omitted from logs.
    });

    return {
      outcome: "accepted",
      providerLogId: id,
      providerMessageId: `sim-${id}`,
      providerStatus: "simulated",
    };
  }

  async getMessageInfo(
    providerLogId: string,
  ): Promise<FeedbackTransportMessageInfo | undefined> {
    const message = this.messages.find((entry) => entry.id === providerLogId);
    if (!message) {
      return undefined;
    }

    return {
      providerLogId: message.id,
      providerMessageId: `sim-${message.id}`,
      status: "sent",
      occurredAt: message.sentAt,
    };
  }

  /** Test and WP8-preview inspection only; not an HTTP surface. */
  listSent(): readonly SimulatedOutboundMessage[] {
    return [...this.messages];
  }

  clear(): void {
    this.messages.length = 0;
  }
}
