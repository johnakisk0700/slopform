import type { MessageOutboxRow } from "@slopform/database";

/** Written by one successful STOP persist; omitted when the ingress fence no-ops. */
export interface FeedbackStopApplied {
  readonly stopAck: MessageOutboxRow;
  readonly closed: boolean;
}
