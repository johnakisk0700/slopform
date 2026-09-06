import type {
  FeedbackCampaignStatus,
  MessageOutboxDeliveryStatus,
  MessageOutboxKind,
  MessageOutboxRow,
  MessageOutboxStatus,
} from "@slopform/database";

import type { DispatchEnqueueRequest } from "./dispatch-context.js";

export type FeedbackOutboxClaimedRow = MessageOutboxRow & {
  readonly status: "claimed";
  readonly claimToken: string;
  readonly claimExpiresAt: Date;
  readonly sendStartedAt: null;
};

export interface FeedbackOutboxTerminalCandidate {
  readonly conversationId: string;
  readonly outboxId: string;
}

export interface FeedbackOutboxStatusProjection {
  readonly outboxId: string;
  readonly status: MessageOutboxStatus;
}

export type FeedbackLegacyClosingResolution =
  | { readonly outcome: "clear" }
  | {
      readonly outcome: "provider_crossed";
      readonly row: MessageOutboxRow;
    };

/**
 * One undelivered outbox row with the campaign context that decides whether it
 * is stuck or deliberately parked: the relay skips any row whose campaign is
 * not `launched`, so `campaignStatus` is what separates "the system is behind"
 * from "an operator pressed pause".
 */
export interface FeedbackUndeliveredOutboxRow {
  readonly row: MessageOutboxRow;
  readonly campaignStatus: FeedbackCampaignStatus;
  readonly eventId: string;
  readonly eventTitle: string;
}

/**
 * Which rows of the history one page is drawn from.
 *
 * `message_outbox` is append-only and never pruned, so the history is a log
 * that outgrows any cap within a single campaign. Every field here narrows the
 * *set*; the cursor below walks it. They are separate on purpose: changing a
 * filter must restart the walk, and a page is only meaningful against the
 * filter it was cut from.
 */
export interface FeedbackOutboxHistoryFilter {
  /** One status, or null for every status the table allows. */
  readonly status: MessageOutboxStatus | null;
  /** Inclusive lower bound on `created_at`; null for «since the beginning». */
  readonly from: Date | null;
  /** Inclusive upper bound on `created_at`; null for «up to now». */
  readonly to: Date | null;
}

/**
 * Where the next page of history starts: the last row of the previous one.
 *
 * Keyset, not offset. This table is written to while an operator reads it, and
 * `OFFSET 50` against a growing log silently repeats rows it has already shown
 * and skips ones it has not — the two failure modes a log viewer must not have.
 * `id` breaks the tie because `created_at` has no uniqueness guarantee.
 */
export interface FeedbackOutboxHistoryCursor {
  readonly createdAt: Date;
  readonly id: string;
}

export interface FeedbackOutboxInsertInput {
  readonly id?: string;
  readonly conversationId: string;
  readonly campaignId: string;
  readonly kind: MessageOutboxKind;
  readonly body: string;
  readonly dedupeKey: string;
  readonly status?: MessageOutboxStatus;
  readonly createdByStaff?: string | null;
  readonly dispatchContext: DispatchEnqueueRequest;
}

export interface FeedbackOutboxDeliveryUpdateInput {
  readonly deliveryStatus: MessageOutboxDeliveryStatus;
  readonly providerLogId?: string | null;
  readonly providerMessageId?: string | null;
  readonly sentAt?: Date | null;
  readonly deliveredAt?: Date | null;
  readonly readAt?: Date | null;
  readonly playedAt?: Date | null;
  readonly status?: MessageOutboxStatus;
}

export interface FeedbackOutboxDispatchSentInput {
  readonly completedAt: Date;
  readonly providerLogId: string;
  readonly providerMessageId?: string;
  readonly deliveryStatus: Exclude<MessageOutboxDeliveryStatus, "error">;
  readonly sentAt?: Date | null;
  readonly deliveredAt?: Date | null;
  readonly readAt?: Date | null;
  readonly playedAt?: Date | null;
}
