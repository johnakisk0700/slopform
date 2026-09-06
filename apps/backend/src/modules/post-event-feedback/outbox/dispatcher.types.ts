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

export type FeedbackOutboxGuardResult =
  | {
      readonly state: "ready";
      readonly phoneAtLaunch: string;
      /** Exact STOP lifecycle authority for the campaign-status marker CAS. */
      readonly authorizedStopOutboxId: string | null;
    }
  | {
      readonly state: "settled";
      readonly result: FeedbackOutboxDispatchItemResult;
    };

export type FeedbackSendSlotResult =
  | { readonly state: "granted" }
  | { readonly state: "failed"; readonly error: unknown };
