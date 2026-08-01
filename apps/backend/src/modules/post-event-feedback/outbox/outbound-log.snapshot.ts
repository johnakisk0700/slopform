import { z } from "zod";

import {
  feedbackConversationControlSchema,
  feedbackConversationGoalSchema,
  feedbackConversationLifecycleSchema,
  type FeedbackConversationDocument,
} from "../post-event-feedback-conversation.document.js";

/**
 * Bounded state captured beside an outbound decision. Deliberately a summary —
 * no transcript bodies, no phone, no participant ids the log row already carries.
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
      })
      .strict(),
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
  return outboundConversationSnapshotSchema.parse({
    lifecycle: {
      state: conversation.lifecycle.state,
      reason: conversation.lifecycle.reason,
    },
    control: {
      mode: conversation.control.mode,
      source: conversation.control.source,
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
    extractionCursorSeq: conversation.extraction.cursorSeq,
    reminderCount: conversation.reminderCount,
  });
}
