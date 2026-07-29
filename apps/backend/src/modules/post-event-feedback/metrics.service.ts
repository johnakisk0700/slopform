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

export const FEEDBACK_EXTRACT_OUTCOMES = [
  "skipped_closed",
  "skipped_human_control",
  /** Promised a human, or read something the bot must not answer. */
  "skipped_awaiting_human",
  "skipped_cursor",
  /** The burst is still going; the run queued behind this one will read it. */
  "skipped_still_typing",
  "skipped_no_new_testimony",
  "extracted",
  "completed",
  /**
   * The ladder settled with nothing in it: every question was declined and no
   * answer was ever recorded. Counted apart from `completed` for the same reason
   * `lifecycle.reason` distinguishes them — a response rate that cannot tell the
   * two apart reads a refusal as a reply.
   */
  "declined",
  "handoff",
] as const;

export type FeedbackExtractOutcome = (typeof FEEDBACK_EXTRACT_OUTCOMES)[number];

export interface FeedbackExtractTokenUsage {
  readonly phase: "feedback_extraction" | "attention_classification";
  readonly model: string;
  /** Pre-call estimate from the assembled prompt. */
  readonly estimatedPromptTokens: number;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
}

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
  private readonly extractCounters = new Map<FeedbackExtractOutcome, number>();
  private tokensObserved = 0;

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

  recordExtractOutcome(
    outcome: FeedbackExtractOutcome,
    correlationId: string,
  ): number {
    const next = (this.extractCounters.get(outcome) ?? 0) + 1;
    this.extractCounters.set(outcome, next);

    this.logger.log({
      event: "feedback.extract.outcome",
      correlationId,
      outcome,
      count: next,
    });

    return next;
  }

  /**
   * ADR 0008 measures extraction input pressure in **tokens**, not message
   * count: a short thread of long Greek paragraphs is the expensive case, and a
   * message counter would rank it as cheap. Both the pre-call estimate and the
   * provider's reported usage are logged so the estimator can be corrected
   * against reality before summarisation is considered.
   */
  recordExtractTokens(
    usage: FeedbackExtractTokenUsage,
    correlationId: string,
  ): number {
    this.tokensObserved += usage.totalTokens ?? usage.estimatedPromptTokens;

    this.logger.log({
      event: "feedback.extract.tokens",
      correlationId,
      phase: usage.phase,
      model: usage.model,
      estimatedPromptTokens: usage.estimatedPromptTokens,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      tokensObserved: this.tokensObserved,
    });

    return this.tokensObserved;
  }

  count(outcome: FeedbackMaterializeOutcome): number {
    return this.counters.get(outcome) ?? 0;
  }

  countExtract(outcome: FeedbackExtractOutcome): number {
    return this.extractCounters.get(outcome) ?? 0;
  }

  totalTokensObserved(): number {
    return this.tokensObserved;
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
