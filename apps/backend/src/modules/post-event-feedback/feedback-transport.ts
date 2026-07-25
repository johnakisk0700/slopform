/**
 * Outbound WhatsApp transport boundary for post-event feedback (WP6).
 *
 * Switched by `TRANSPORT_MODE`:
 * - `wasender` → paced Wasender session client
 * - `simulated` → in-memory sink (WP8 replaces this with a durable sink +
 *   inject/read endpoints; do not add those here)
 */
export const FEEDBACK_TRANSPORT = Symbol("join-the-six.feedback-transport");

export type FeedbackTransportSendInput = {
  readonly to: string;
  readonly text: string;
  readonly outboxId: string;
};

export type FeedbackTransportSendResult =
  | {
      readonly outcome: "accepted";
      readonly providerLogId: string;
      readonly providerStatus: string;
      readonly providerMessageId?: string;
    }
  | {
      readonly outcome: "not-accepted";
      readonly reason: string;
      readonly retryAfterSeconds?: number;
    }
  | {
      readonly outcome: "unknown";
      readonly reason: string;
      readonly providerLogId?: string;
    };

export type FeedbackTransportMessageInfo = {
  readonly providerLogId: string;
  readonly providerMessageId: string;
  readonly status:
    "error" | "pending" | "sent" | "delivered" | "read" | "played";
  readonly occurredAt: Date;
};

/**
 * Injectable port. Callers must never blindly retry an `unknown` send outcome;
 * reconcile through stored provider IDs / status first.
 */
export interface FeedbackTransport {
  sendText(
    input: FeedbackTransportSendInput,
  ): Promise<FeedbackTransportSendResult>;

  /**
   * Optional provider reconciliation. Simulated transport has nothing to look
   * up; Wasender uses `getMessageInfo`.
   */
  getMessageInfo?(
    providerLogId: string,
  ): Promise<FeedbackTransportMessageInfo | undefined>;
}
