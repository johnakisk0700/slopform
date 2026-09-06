import type { MessageOutboxRow } from "@slopform/database";

import type { FeedbackOutboxDispatchItemResult } from "./dispatcher.types.js";

/** Guard and pre-send marker results for FeedbackDispatchPreparationService. */
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

export type FeedbackDispatchPreparedSend = {
  readonly state: "prepared";
  readonly attempting: MessageOutboxRow;
  readonly phoneAtLaunch: string;
};

export type FeedbackDispatchPrepareResult =
  | FeedbackDispatchPreparedSend
  | Extract<FeedbackOutboxGuardResult, { readonly state: "settled" }>;
