import { Injectable } from "@nestjs/common";

import {
  WasenderClient,
  WasenderClientError,
} from "../../../integrations/wasender/wasender.client.js";
import type {
  FeedbackTransport,
  FeedbackTransportSendInput,
  FeedbackTransportSendResult,
} from "./transport.js";

/**
 * Raw Wasender-backed transport. The dispatcher owns deployment-wide pacing
 * and the durable provider-entry marker; this adapter maps one provider call
 * and never retries an unknown outcome.
 */
@Injectable()
export class WasenderFeedbackTransport implements FeedbackTransport {
  constructor(private readonly client: WasenderClient) {}

  async sendText(
    input: FeedbackTransportSendInput,
  ): Promise<FeedbackTransportSendResult> {
    try {
      const result = await this.client.sendText({
        to: input.to,
        text: input.text,
      });

      let providerMessageId: string | undefined;
      try {
        const info = await this.client.getMessageInfo(result.providerLogId);
        providerMessageId = info.providerMessageId;
      } catch {
        // Acceptance is already known; the WhatsApp id can arrive later via
        // upsert correlation or a reconcile pass.
      }

      return {
        outcome: "accepted",
        providerLogId: String(result.providerLogId),
        providerStatus: result.providerStatus,
        ...(providerMessageId ? { providerMessageId } : {}),
      };
    } catch (error) {
      if (!(error instanceof WasenderClientError)) {
        return {
          outcome: "unknown",
          reason: "unexpected_transport_error",
        };
      }

      if (error.deliveryOutcome === "not-accepted") {
        return {
          outcome: "not-accepted",
          reason: error.kind,
          ...(error.retryAfterSeconds !== undefined
            ? { retryAfterSeconds: error.retryAfterSeconds }
            : {}),
        };
      }

      return {
        outcome: "unknown",
        reason: error.kind,
      };
    }
  }
}
