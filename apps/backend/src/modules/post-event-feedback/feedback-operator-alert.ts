import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import type { Environment } from "../../infrastructure/config/environment.js";

/**
 * The operator alert seam.
 *
 * `needsAttention` is the durable operator signal — it lives on the
 * conversation, survives a restart and is what the admin inbox renders. This
 * port is the *notification* half: it fires when a conversation crosses from
 * calm to needing attention, so nobody has to be watching the inbox for a
 * safety disclosure or a dead extraction run to be noticed.
 *
 * It is invoked only on a real `false → true` transition. The conversation
 * repository already reports that (`setNeedsAttention` returns `changed`), so
 * idempotency is structural: a replayed job re-asserts `true`, sees
 * `changed: false` and raises nothing. That is the only reason this port can be
 * fire-and-forget without spamming an operator on every retry.
 */

export const FEEDBACK_OPERATOR_ALERT = Symbol("FEEDBACK_OPERATOR_ALERT");

export const FEEDBACK_OPERATOR_ALERT_REASONS = [
  /** The deterministic safety tripwire matched a participant message (D13). */
  "safety_keywords",
  /** The model itself signalled safety content or asked for a human. */
  "extraction_safety_signal",
  /** `feedback.extract.v1` failed permanently and the fallback took over. */
  "extraction_failed",
] as const;

export type FeedbackOperatorAlertReason =
  (typeof FEEDBACK_OPERATOR_ALERT_REASONS)[number];

export interface FeedbackOperatorAlertInput {
  readonly conversationId: string;
  readonly campaignId: string;
  readonly reason: FeedbackOperatorAlertReason;
  readonly correlationId: string;
  /**
   * Bounded classification only — a safety category set or a failure cause.
   * Never participant text: an alert may travel further than the database it
   * came from.
   */
  readonly detail?: readonly string[];
}

export interface FeedbackOperatorAlert {
  raise(input: FeedbackOperatorAlertInput): Promise<void>;
}

/**
 * The only implementation today: a structured log line an operator's log search
 * can alert on.
 *
 * `FEEDBACK_OPERATOR_ALERT_MODE` exists so the delivery channel is a
 * configuration decision rather than a code edit. It accepts `log` (default)
 * and `off`. A future WhatsApp adapter — a `WasenderFeedbackOperatorAlert`
 * sending to a configured operator number — is the named extension point and is
 * deliberately **not** implemented here: it needs an operator-number
 * configuration, a rate limit and a privacy review of its own, none of which
 * belong to this change.
 */
@Injectable()
export class LoggingFeedbackOperatorAlert implements FeedbackOperatorAlert {
  private readonly logger = new Logger(LoggingFeedbackOperatorAlert.name);
  private readonly mode: Environment["FEEDBACK_OPERATOR_ALERT_MODE"];

  constructor(config: ConfigService<Environment, true>) {
    this.mode = config.get("FEEDBACK_OPERATOR_ALERT_MODE", { infer: true });
  }

  async raise(input: FeedbackOperatorAlertInput): Promise<void> {
    if (this.mode === "off") {
      return;
    }

    this.logger.warn({
      event: "feedback.operator_alert",
      correlationId: input.correlationId,
      conversationId: input.conversationId,
      campaignId: input.campaignId,
      reason: input.reason,
      ...(input.detail && input.detail.length > 0
        ? { detail: [...input.detail] }
        : {}),
    });
  }
}
