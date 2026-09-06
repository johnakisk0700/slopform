import { z } from "zod";

import {
  FEEDBACK_CONVERSATION_MAX_MESSAGES,
  feedbackConversationControlSchema,
  feedbackConversationGoalSchema,
  feedbackConversationLifecycleSchema,
  resolveFeedbackConversationWork,
  type FeedbackConversationDocument,
} from "../post-event-feedback-conversation.document.js";

/**
 * Bounded historical state beside an outbound decision. Dispatch authority is
 * stored separately on the outbox row, not inferred from this projection.
 */
export const outboundConversationSnapshotSchema = z
  .object({
    lifecycle: z
      .object({
        state: feedbackConversationLifecycleSchema.shape.state,
        reason: feedbackConversationLifecycleSchema.shape.reason,
      })
      .strict(),
    control: z
      .object({
        mode: feedbackConversationControlSchema.shape.mode,
        source: feedbackConversationControlSchema.shape.source,
        /** Optional so historical rows remain readable. */
        changedAt: z.iso.datetime().optional(),
      })
      .strict(),
    /** Work generation observed by the producer; absent in older history. */
    work: z
      .object({
        revision: z.number().int().min(0),
        executionEpoch: z.number().int().min(0),
        campaignResumeGeneration: z.number().int().min(0).nullable(),
      })
      .strict()
      .optional(),
    awaitingHuman: z.boolean(),
    needsAttention: z.boolean(),
    unresolvedAttentionCount: z.number().int().min(0),
    goals: z.array(
      z
        .object({
          key: feedbackConversationGoalSchema.shape.key,
          status: feedbackConversationGoalSchema.shape.status,
        })
        .strict(),
    ),
    messageCount: z.number().int().min(0),
    latestMessageSeq: z.number().int().min(1).nullable(),
    /** Participant ingress in this historical snapshot; absent in older rows. */
    participantIngressIds: z
      .array(z.uuid())
      .max(FEEDBACK_CONVERSATION_MAX_MESSAGES)
      .optional(),
    extractionCursorSeq: z.number().int().min(0),
    reminderCount: z.number().int().min(0),
  })
  .strict();

export type OutboundConversationSnapshot = z.infer<
  typeof outboundConversationSnapshotSchema
>;

export function buildOutboundConversationSnapshot(
  conversation: FeedbackConversationDocument,
): OutboundConversationSnapshot {
  const work = resolveFeedbackConversationWork(conversation.work);
  return outboundConversationSnapshotSchema.parse({
    lifecycle: {
      state: conversation.lifecycle.state,
      reason: conversation.lifecycle.reason,
    },
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
    awaitingHuman: conversation.awaitingHuman,
    needsAttention: conversation.needsAttention,
    unresolvedAttentionCount: conversation.attentionReasons.filter(
      (reason) => reason.resolvedAt === null,
    ).length,
    goals: conversation.goals.map((goal) => ({
      key: goal.key,
      status: goal.status,
    })),
    messageCount: conversation.messages.length,
    latestMessageSeq:
      conversation.messages.length === 0
        ? null
        : Math.max(...conversation.messages.map((message) => message.seq)),
    participantIngressIds: conversation.messages.flatMap((message) =>
      message.actor === "participant" && message.ingressId
        ? [message.ingressId]
        : [],
    ),
    extractionCursorSeq: conversation.extraction.cursorSeq,
    reminderCount: conversation.reminderCount,
  });
}
