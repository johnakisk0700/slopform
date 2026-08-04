/**
 * Outbound WhatsApp transport boundary for post-event feedback (WP6).
 *
 * Switched by `TRANSPORT_MODE`:
 * - `disabled` → deterministic local rejection; no provider is reachable
 * - `wasender` → raw Wasender session client; the dispatcher owns pacing
 * - `simulated` → durable PostgreSQL sink (`feedback_sim_outbound`) plus
 *   inject/read HTTP endpoints when the simulator policy permits them
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

/**
 * Injectable port. Callers must never blindly retry an `unknown` send outcome;
 * reconcile through stored provider IDs / status first.
 */
export interface FeedbackTransport {
  sendText(
    input: FeedbackTransportSendInput,
  ): Promise<FeedbackTransportSendResult>;
}
