/** Why ordinary inbound settled as failed rather than a transcript turn. */
export type FeedbackUnmaterializedInboundReason =
  "empty_body" | "transcript_capacity";
