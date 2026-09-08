import type { MessageOutboxKind } from "@slopform/database";
import { z } from "zod";

import {
  FEEDBACK_FALLBACK_DEDUPE_PREFIX,
  FEEDBACK_HANDOFF_DEDUPE_PREFIX,
  FEEDBACK_REPLY_DEDUPE_PREFIX,
  createFeedbackExtractionParkedNoticeDedupeKey,
  createFeedbackFallbackAckDedupeKey,
  createFeedbackHostilityStopDedupeKey,
  isFeedbackClosingDedupeKey,
} from "../extraction/extraction.schemas.js";
import {
  FEEDBACK_CONVERSATION_MAX_MESSAGES,
  feedbackConversationControlSchema,
  resolveFeedbackConversationWork,
  type FeedbackConversationDocument,
} from "../post-event-feedback-conversation.document.js";
import {
  createFeedbackIntroDedupeKey,
  createFeedbackMediaNoticeDedupeKey,
  createFeedbackReminderDedupeKey,
  createFeedbackStopAckDedupeKey,
} from "../question-set.js";

export const DISPATCH_CONTEXT_SCHEMA_VERSION = 1 as const;

export const ordinaryDispatchEvidenceSchema = z
  .object({
    latestMessageSeq: z.number().int().min(1).nullable(),
    control: z
      .object({
        mode: feedbackConversationControlSchema.shape.mode,
        source: feedbackConversationControlSchema.shape.source,
        changedAt: z.iso.datetime(),
      })
      .strict(),
    work: z
      .object({
        revision: z.number().int().min(0),
        executionEpoch: z.number().int().min(0),
        campaignResumeGeneration: z.number().int().min(0).nullable(),
      })
      .strict(),
    participantIngressIds: z
      .array(z.uuid())
      .max(FEEDBACK_CONVERSATION_MAX_MESSAGES),
  })
  .strict();

export type OrdinaryDispatchEvidence = z.infer<
  typeof ordinaryDispatchEvidenceSchema
>;

const versioned = {
  schemaVersion: z.literal(DISPATCH_CONTEXT_SCHEMA_VERSION),
};

export const dispatchContextSchema = z.discriminatedUnion("purpose", [
  z
    .object({
      ...versioned,
      purpose: z.literal("extraction_reply"),
      evidence: ordinaryDispatchEvidenceSchema,
    })
    .strict(),
  z
    .object({
      ...versioned,
      purpose: z.literal("extraction_closing"),
      closingReason: z.enum(["completed", "declined"]),
    })
    .strict(),
  z
    .object({
      ...versioned,
      purpose: z.literal("campaign_intro"),
    })
    .strict(),
  z
    .object({
      ...versioned,
      purpose: z.literal("reminder"),
      rung: z.number().int().min(1),
    })
    .strict(),
  z
    .object({
      ...versioned,
      purpose: z.literal("staff_message"),
      staffActorId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      ...versioned,
      purpose: z.literal("stop_ack"),
      sourceIngressId: z.uuid(),
    })
    .strict(),
  z
    .object({
      ...versioned,
      purpose: z.literal("media_notice"),
      sourceIngressId: z.uuid(),
    })
    .strict(),
  z
    .object({
      ...versioned,
      purpose: z.literal("extraction_parked_notice"),
    })
    .strict(),
  z
    .object({
      ...versioned,
      purpose: z.literal("extraction_fallback_fence"),
    })
    .strict(),
  z
    .object({
      ...versioned,
      purpose: z.literal("extraction_fallback_ack"),
    })
    .strict(),
  z
    .object({
      ...versioned,
      purpose: z.literal("unusable_legacy"),
    })
    .strict(),
]);

export type DispatchContext = z.infer<typeof dispatchContextSchema>;

export type DispatchEnqueueRequest = Exclude<
  DispatchContext,
  { readonly purpose: "unusable_legacy" }
>;

export type UsableDispatchContext = DispatchEnqueueRequest;

export const DISPATCH_CONTEXT_INVALID = "dispatch_context_invalid";
export const DISPATCH_CONTEXT_UNUSABLE = "dispatch_context_unusable";
export const DISPATCH_CONTEXT_MISMATCH = "dispatch_context_mismatch";
export const DISPATCH_CONTEXT_CLOSING_REASON_MISMATCH =
  "dispatch_context_closing_reason_mismatch";
export const FALLBACK_FENCE_NOT_SENDABLE = "fallback_fence_not_sendable";

export type DispatchContextRejectReason =
  | typeof DISPATCH_CONTEXT_INVALID
  | typeof DISPATCH_CONTEXT_UNUSABLE
  | typeof DISPATCH_CONTEXT_MISMATCH
  | typeof DISPATCH_CONTEXT_CLOSING_REASON_MISMATCH
  | typeof FALLBACK_FENCE_NOT_SENDABLE;

export type DispatchAuthority =
  | { readonly state: "usable"; readonly context: UsableDispatchContext }
  | { readonly state: "reject"; readonly reason: DispatchContextRejectReason };

export function kindForDispatchPurpose(
  purpose: DispatchEnqueueRequest["purpose"],
): MessageOutboxKind {
  switch (purpose) {
    case "extraction_reply":
    case "extraction_closing":
      return "reply";
    case "campaign_intro":
      return "intro";
    case "reminder":
      return "reminder";
    case "staff_message":
      return "staff";
    case "stop_ack":
    case "media_notice":
    case "extraction_parked_notice":
    case "extraction_fallback_fence":
    case "extraction_fallback_ack":
      return "system";
  }
}

export function ordinaryDispatchEvidenceFromConversation(
  conversation: FeedbackConversationDocument,
): OrdinaryDispatchEvidence {
  const work = resolveFeedbackConversationWork(conversation.work);
  return {
    latestMessageSeq:
      conversation.messages.length === 0
        ? null
        : Math.max(...conversation.messages.map((message) => message.seq)),
    control: {
      mode: conversation.control.mode,
      source: conversation.control.source,
      changedAt: conversation.control.changedAt.toISOString(),
    },
    work: {
      revision: work.revision,
      executionEpoch: work.executionEpoch,
      campaignResumeGeneration: work.campaignResumeGeneration ?? null,
    },
    participantIngressIds: conversation.messages.flatMap((message) =>
      message.actor === "participant" && message.ingressId
        ? [message.ingressId]
        : [],
    ),
  };
}

export function parseDispatchContext(value: unknown): DispatchAuthority {
  const parsed = dispatchContextSchema.safeParse(value);
  if (!parsed.success) {
    return { state: "reject", reason: DISPATCH_CONTEXT_INVALID };
  }
  if (parsed.data.purpose === "unusable_legacy") {
    return { state: "reject", reason: DISPATCH_CONTEXT_UNUSABLE };
  }
  return { state: "usable", context: parsed.data };
}

export function evaluateDispatchContext(input: {
  readonly context: unknown;
  readonly kind: string;
  readonly dedupeKey: string;
  readonly conversationId: string;
}): DispatchAuthority {
  const parsed = parseDispatchContext(input.context);
  if (parsed.state === "reject") return parsed;
  if (parsed.context.purpose === "extraction_fallback_fence") {
    return { state: "reject", reason: FALLBACK_FENCE_NOT_SENDABLE };
  }
  if (
    !purposeMatchesKindAndDedupe(
      parsed.context,
      input.kind,
      input.dedupeKey,
      input.conversationId,
    )
  ) {
    return { state: "reject", reason: DISPATCH_CONTEXT_MISMATCH };
  }
  return parsed;
}

export function assertEnqueueDispatchContext(
  context: DispatchEnqueueRequest,
  kind: string,
  dedupeKey: string,
  conversationId: string,
): void {
  if (!purposeMatchesKindAndDedupe(context, kind, dedupeKey, conversationId)) {
    throw new Error(
      `Outbound dispatch context ${context.purpose} does not match kind ${kind} or dedupe key`,
    );
  }
}

function purposeMatchesKindAndDedupe(
  context: UsableDispatchContext,
  kind: string,
  dedupeKey: string,
  conversationId: string,
): boolean {
  if (kind !== kindForDispatchPurpose(context.purpose)) {
    return false;
  }
  switch (context.purpose) {
    case "extraction_reply":
      return isOrdinaryExtractionDedupeKey(conversationId, dedupeKey);
    case "extraction_closing":
      return isFeedbackClosingDedupeKey(conversationId, dedupeKey);
    case "campaign_intro":
      return dedupeKey === createFeedbackIntroDedupeKey(conversationId);
    case "reminder":
      return (
        dedupeKey ===
        createFeedbackReminderDedupeKey(conversationId, context.rung)
      );
    case "staff_message":
      return isFeedbackStaffDedupeKey(conversationId, dedupeKey);
    case "stop_ack":
      return dedupeKey === createFeedbackStopAckDedupeKey(conversationId);
    case "media_notice":
      return dedupeKey === createFeedbackMediaNoticeDedupeKey(conversationId);
    case "extraction_parked_notice":
      return (
        dedupeKey ===
        createFeedbackExtractionParkedNoticeDedupeKey(conversationId)
      );
    case "extraction_fallback_fence":
      return isFeedbackFallbackFenceDedupeKey(conversationId, dedupeKey);
    case "extraction_fallback_ack":
      return dedupeKey === createFeedbackFallbackAckDedupeKey(conversationId);
  }
}

function isOrdinaryExtractionDedupeKey(
  conversationId: string,
  dedupeKey: string,
): boolean {
  return (
    isPrefixedTestimonyDedupeKey(
      FEEDBACK_REPLY_DEDUPE_PREFIX,
      conversationId,
      dedupeKey,
    ) ||
    isPrefixedTestimonyDedupeKey(
      FEEDBACK_HANDOFF_DEDUPE_PREFIX,
      conversationId,
      dedupeKey,
    ) ||
    dedupeKey === createFeedbackHostilityStopDedupeKey(conversationId)
  );
}

function isPrefixedTestimonyDedupeKey(
  prefix: string,
  conversationId: string,
  dedupeKey: string,
): boolean {
  const head = `${prefix}-${conversationId}-`;
  if (!dedupeKey.startsWith(head)) return false;
  return isCanonicalPositiveDecimal(dedupeKey.slice(head.length));
}

function isFeedbackStaffDedupeKey(
  conversationId: string,
  dedupeKey: string,
): boolean {
  const head = `feedback-staff-${conversationId}-`;
  return dedupeKey.startsWith(head) && dedupeKey.length > head.length;
}

function isFeedbackFallbackFenceDedupeKey(
  conversationId: string,
  dedupeKey: string,
): boolean {
  const head = `${FEEDBACK_FALLBACK_DEDUPE_PREFIX}-${conversationId}-`;
  if (!dedupeKey.startsWith(head) || dedupeKey.endsWith("-ack")) {
    return false;
  }
  return isCanonicalPositiveDecimal(dedupeKey.slice(head.length));
}

function isCanonicalPositiveDecimal(value: string): boolean {
  return /^[1-9][0-9]*$/u.test(value);
}
