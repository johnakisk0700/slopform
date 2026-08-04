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
        /**
         * Exact control generation the producer admitted. Optional only so
         * historical audit rows remain parseable; they are not fresh enough
         * to authorize a new provider call.
         */
        changedAt: z.iso.datetime().optional(),
      })
      .strict(),
    /**
     * Durable work generation observed by the producer.
     *
     * Reconciliation may legitimately settle revision N as N+1 after the
     * outbox insert, so revision is not the primary dispatch authorization.
     * The execution and campaign-resume generations do not have that benign
     * transition and close two provider-entry ABA windows.
     */
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
    /**
     * Participant ingress rows present in the model/outbound snapshot.
     *
     * Optional keeps historical audit rows readable. New extraction rows use
     * it at the dispatcher's final provider-entry fence: any durable inbound
     * not in this set supersedes an ordinary reply, including a row still
     * waiting for Mongo materialization.
     */
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
