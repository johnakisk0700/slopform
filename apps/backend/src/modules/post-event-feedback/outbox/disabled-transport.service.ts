import { Injectable } from "@nestjs/common";

import type {
  FeedbackTransport,
  FeedbackTransportSendInput,
  FeedbackTransportSendResult,
} from "./transport.js";

/**
 * Production-safe sink used while outbound WhatsApp delivery is intentionally
 * disabled. It has no provider dependency and rejects every attempted send with
 * one stable reason, so the delivery consumer fails the outbox row visibly
 * instead of pretending it was sent or deferring a surprise send until later.
 */
@Injectable()
export class DisabledFeedbackTransport implements FeedbackTransport {
  sendText(
    _input: FeedbackTransportSendInput,
  ): Promise<FeedbackTransportSendResult> {
    return Promise.resolve({
      outcome: "not-accepted",
      reason: "transport_disabled",
    });
  }
}
