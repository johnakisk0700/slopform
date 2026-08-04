import { z } from "zod";

import { latestParticipantMessage } from "../conversation-reader.js";
import {
  type FeedbackConversationDocument,
  resolveFeedbackConversationWork,
} from "../post-event-feedback-conversation.document.js";

export const FEEDBACK_PAUSED_CAMPAIGN_RECOMMENDATION =
  "freeze_all_automation" as const;

export type FeedbackReconciliationCampaignStatus =
  "launched" | "paused" | "closed";

export interface FeedbackConversationReconciliationPolicy {
  readonly quietWindowMs: number;
  readonly reminderIntervalMs: number;
  readonly expireAfterMs: number;
  readonly maxReminders: number;
  readonly parkRetryMs: number;
  readonly parkMaxMs: number;
}

export type FeedbackConversationReconciliationPlan =
  | {
      readonly kind: "idle";
      readonly reason:
        | "conversation_closed"
        | "human_control"
        | "awaiting_human"
        | "campaign_missing"
        | "campaign_closed";
    }
  | {
      readonly kind: "idle";
      readonly reason: "campaign_paused";
      /**
       * Explicit target policy, because the legacy paths disagree: extraction
       * may still buy model calls and persist results while reminders stop and
       * expiry continues. Reconciliation recommends one coherent pause instead.
       */
      readonly recommendation: typeof FEEDBACK_PAUSED_CAMPAIGN_RECOMMENDATION;
    }
  | {
      readonly kind: "wait";
      readonly reason: "quiet_window" | "park_retry" | "reminder" | "expiry";
      readonly until: Date;
    }
  | {
      readonly kind: "extract";
      readonly reason: "unread_testimony";
      readonly snapshotSeq: number;
    }
  | {
      readonly kind: "retry_parked";
      readonly reason: "provider_incident";
      readonly snapshotSeq: number;
      readonly parkedRun: number;
    }
  | {
      readonly kind: "expire";
      readonly reason: "participant_silent";
      readonly silentSince: Date;
    }
  | {
      readonly kind: "remind";
      readonly reason: "participant_silent";
      readonly ordinal: number;
    };

const reconciliationPolicySchema = z
  .object({
    quietWindowMs: z.number().int().positive(),
    reminderIntervalMs: z.number().int().positive(),
    expireAfterMs: z.number().int().positive(),
    maxReminders: z.number().int().min(0),
    parkRetryMs: z.number().int().positive(),
    parkMaxMs: z.number().int().positive(),
  })
  .strict();

/**
 * Derives exactly one transition from current durable state.
 *
 * It never trusts why a job was enqueued. A wake-up may be late, duplicated or
 * positional history from an older deploy; the aggregate, campaign and consent
 * observed now decide whether any work remains. One invocation returns at most
 * one expensive or irreversible action (`extract`, `retry_parked`, `remind` or
 * `expire`). Its caller settles the returned next wake-up after that action.
 */
export function deriveFeedbackConversationReconciliationPlan(input: {
  readonly conversation: FeedbackConversationDocument;
  readonly campaignStatus: FeedbackReconciliationCampaignStatus | null;
  readonly consentGranted: boolean;
  readonly now: Date;
  readonly policy: FeedbackConversationReconciliationPolicy;
}): FeedbackConversationReconciliationPlan {
  const now = z.date().parse(input.now);
  const policy = reconciliationPolicySchema.parse(input.policy);
  const { conversation } = input;

  if (conversation.lifecycle.state === "closed") {
    return { kind: "idle", reason: "conversation_closed" };
  }
  if (conversation.control.mode === "human") {
    return { kind: "idle", reason: "human_control" };
  }
  if (conversation.awaitingHuman) {
    return { kind: "idle", reason: "awaiting_human" };
  }
  if (input.campaignStatus === null) {
    return { kind: "idle", reason: "campaign_missing" };
  }
  if (input.campaignStatus === "closed") {
    return { kind: "idle", reason: "campaign_closed" };
  }
  if (input.campaignStatus === "paused") {
    return {
      kind: "idle",
      reason: "campaign_paused",
      recommendation: FEEDBACK_PAUSED_CAMPAIGN_RECOMMENDATION,
    };
  }

  const newestParticipant = latestParticipantMessage(conversation);
  const silentSince = newestParticipant?.at ?? conversation.createdAt;
  const expiryAt = plusMs(silentSince, policy.expireAfterMs);

  // Consent withdrawal forbids model work and outbound messages, but it does
  // not make an open conversation immortal. Silent expiry sends nothing and
  // eventually releases the partial unique phone index.
  if (!input.consentGranted) {
    return now >= expiryAt
      ? { kind: "expire", reason: "participant_silent", silentSince }
      : { kind: "wait", reason: "expiry", until: expiryAt };
  }

  const unreadParticipantMessages = conversation.messages.filter(
    (message) =>
      message.actor === "participant" &&
      message.seq > conversation.extraction.cursorSeq,
  );
  const snapshotSeq = conversation.messages.reduce(
    (highest, message) => Math.max(highest, message.seq),
    0,
  );
  const parkedSince = conversation.extraction.parkedSince;

  if (unreadParticipantMessages.length > 0 && parkedSince !== null) {
    const parkExhausted =
      now.getTime() - parkedSince.getTime() >= policy.parkMaxMs;
    if (!parkExhausted) {
      const work = resolveFeedbackConversationWork(conversation.work);
      // `updatedAt + retry` bridges a legacy park whose current work timestamp
      // still points at the extraction that just failed. Once reconciliation
      // has settled the retry, its `nextActionAt` is at least that late. Taking
      // the later value prevents both an immediate outage loop and an early
      // execution after a newer durable schedule replaced it.
      const legacyRetryAt = plusMs(conversation.updatedAt, policy.parkRetryMs);
      const retryAt = work.nextActionAt
        ? laterDate(work.nextActionAt, legacyRetryAt)
        : legacyRetryAt;
      if (now < retryAt) {
        return { kind: "wait", reason: "park_retry", until: retryAt };
      }
      return {
        kind: "retry_parked",
        reason: "provider_incident",
        snapshotSeq,
        parkedRun: conversation.extraction.parkedRuns + 1,
      };
    }
  }

  if (unreadParticipantMessages.length > 0 && parkedSince === null) {
    const quietUntil = plusMs(
      newestParticipant?.at ?? conversation.updatedAt,
      policy.quietWindowMs,
    );
    if (now < quietUntil) {
      return { kind: "wait", reason: "quiet_window", until: quietUntil };
    }
    return {
      kind: "extract",
      reason: "unread_testimony",
      snapshotSeq,
    };
  }

  if (now >= expiryAt) {
    return { kind: "expire", reason: "participant_silent", silentSince };
  }

  // A parked or flagged conversation must not receive a questionnaire nudge.
  // Expiry remains scheduled because it sends nothing and releases the phone.
  if (parkedSince !== null || conversation.needsAttention) {
    return { kind: "wait", reason: "expiry", until: expiryAt };
  }

  const reminderOrdinal = conversation.reminderCount + 1;
  if (reminderOrdinal <= policy.maxReminders) {
    const reminderAt = plusMs(
      silentSince,
      reminderOrdinal * policy.reminderIntervalMs,
    );
    if (now >= reminderAt) {
      return {
        kind: "remind",
        reason: "participant_silent",
        ordinal: reminderOrdinal,
      };
    }
    if (reminderAt < expiryAt) {
      return { kind: "wait", reason: "reminder", until: reminderAt };
    }
  }

  return { kind: "wait", reason: "expiry", until: expiryAt };
}

function plusMs(date: Date, milliseconds: number): Date {
  return new Date(date.getTime() + milliseconds);
}

function laterDate(left: Date, right: Date): Date {
  return left >= right ? left : right;
}
