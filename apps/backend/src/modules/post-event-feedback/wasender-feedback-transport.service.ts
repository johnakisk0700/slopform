import { Injectable, Logger } from "@nestjs/common";

import {
  WasenderClient,
  WasenderClientError,
} from "../../integrations/wasender/wasender.client.js";
import {
  FeedbackSessionPacer,
  FEEDBACK_SEND_JITTER_MS,
  FEEDBACK_SEND_MIN_INTERVAL_MS,
} from "./feedback-session-pacer.js";
import type {
  FeedbackTransport,
  FeedbackTransportMessageInfo,
  FeedbackTransportSendInput,
  FeedbackTransportSendResult,
} from "./feedback-transport.js";

/**
 * Wasender-backed transport. Every send waits on the shared-session pacer
 * before calling `sendText`. Unknown provider outcomes are returned to the
 * caller for reconciliation — this adapter never retries.
 */
@Injectable()
export class WasenderFeedbackTransport implements FeedbackTransport {
  private readonly logger = new Logger(WasenderFeedbackTransport.name);
  private readonly pacer: FeedbackSessionPacer;

  constructor(
    private readonly client: WasenderClient,
    pacer?: FeedbackSessionPacer,
  ) {
    this.pacer =
      pacer ??
      new FeedbackSessionPacer({
        minIntervalMs: FEEDBACK_SEND_MIN_INTERVAL_MS,
        jitterMs: FEEDBACK_SEND_JITTER_MS,
      });
  }

  async sendText(
    input: FeedbackTransportSendInput,
  ): Promise<FeedbackTransportSendResult> {
    const paced = await this.pacer.waitTurn();
    this.logger.log({
      event: "feedback.transport.wasender.paced",
      outboxId: input.outboxId,
      waitedMs: paced.waitedMs,
    });

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

  async getMessageInfo(
    providerLogId: string,
  ): Promise<FeedbackTransportMessageInfo | undefined> {
    const numericId = Number(providerLogId);
    if (!Number.isInteger(numericId) || numericId <= 0) {
      return undefined;
    }

    try {
      const info = await this.client.getMessageInfo(numericId);
      return {
        providerLogId: String(info.providerLogId),
        providerMessageId: info.providerMessageId,
        status: info.status,
        occurredAt: new Date(info.occurredAt),
      };
    } catch (error) {
      if (
        error instanceof WasenderClientError &&
        error.deliveryOutcome === "not-applicable" &&
        error.statusCode === 404
      ) {
        return undefined;
      }
      throw error;
    }
  }
}
