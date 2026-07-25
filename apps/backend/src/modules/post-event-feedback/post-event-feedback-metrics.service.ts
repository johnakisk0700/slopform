import { Injectable, Logger } from "@nestjs/common";

export const FEEDBACK_MATERIALIZE_OUTCOMES = [
  "already_processed",
  "ignored_unmatched",
  "inbound_materialized",
  "inbound_stopped",
  "inbound_not_materialized",
  "outbound_correlated",
  "outbound_external",
] as const;

export type FeedbackMaterializeOutcome =
  (typeof FEEDBACK_MATERIALIZE_OUTCOMES)[number];

/**
 * Process-local materialization counters. The deployment exports traces only,
 * so these are surfaced as structured log events and read by tests and the
 * worker's own diagnostics; they are not a metrics backend and are reset by a
 * restart. Unmatched shared-session traffic (D10) is the counter that matters:
 * it must stay flat once a campaign is live.
 */
@Injectable()
export class PostEventFeedbackMetrics {
  private readonly logger = new Logger(PostEventFeedbackMetrics.name);
  private readonly counters = new Map<FeedbackMaterializeOutcome, number>();

  recordMaterializeOutcome(
    outcome: FeedbackMaterializeOutcome,
    correlationId: string,
  ): number {
    const next = (this.counters.get(outcome) ?? 0) + 1;
    this.counters.set(outcome, next);

    this.logger.log({
      event: "feedback.materialize.outcome",
      correlationId,
      outcome,
      count: next,
    });

    return next;
  }

  count(outcome: FeedbackMaterializeOutcome): number {
    return this.counters.get(outcome) ?? 0;
  }

  snapshot(): Record<FeedbackMaterializeOutcome, number> {
    return Object.fromEntries(
      FEEDBACK_MATERIALIZE_OUTCOMES.map((outcome) => [
        outcome,
        this.count(outcome),
      ]),
    ) as Record<FeedbackMaterializeOutcome, number>;
  }
}
