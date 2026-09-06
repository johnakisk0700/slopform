/** Both outcomes of the limiter promise used by the claim-heartbeat wait. */
export type FeedbackSendSlotResult =
  | { readonly state: "granted" }
  | { readonly state: "failed"; readonly error: unknown };
