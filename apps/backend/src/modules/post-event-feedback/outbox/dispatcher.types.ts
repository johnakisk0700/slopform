export type FeedbackOutboxDispatchOutcome =
  | "sent"
  | "failed"
  | "cancelled"
  | "held"
  | "ambiguous"
  | "claim_lost"
  | "deferred";

export type FeedbackOutboxDispatchItemResult = {
  readonly outboxId: string;
  readonly outcome: FeedbackOutboxDispatchOutcome;
};

export type FeedbackOutboxDispatchBatchResult = {
  readonly claimedCount: number;
  readonly quarantinedCount: number;
  readonly items: readonly FeedbackOutboxDispatchItemResult[];
};
