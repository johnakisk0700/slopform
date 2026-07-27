import { z } from "zod";

/**
 * Bounded safety taxonomy shared by model output, MongoDB and the admin read
 * model.
 *
 * The model selects enum values. Presentation (labels, icons and colour) stays
 * a frontend concern so no provider can invent operator-facing UI.
 */
export const POST_EVENT_FEEDBACK_SAFETY_CATEGORIES = [
  "sexual_misconduct",
  "harassment",
  "violence_or_threat",
  "self_harm",
  "other_safety",
] as const;

export const postEventFeedbackSafetyCategorySchema = z.enum(
  POST_EVENT_FEEDBACK_SAFETY_CATEGORIES,
);

export type PostEventFeedbackSafetyCategory = z.infer<
  typeof postEventFeedbackSafetyCategorySchema
>;

export const POST_EVENT_FEEDBACK_RECOMMENDED_ACTIONS = [
  "review",
  "human_follow_up",
  "urgent_human_follow_up",
] as const;

export const postEventFeedbackRecommendedActionSchema = z.enum(
  POST_EVENT_FEEDBACK_RECOMMENDED_ACTIONS,
);

export type PostEventFeedbackRecommendedAction = z.infer<
  typeof postEventFeedbackRecommendedActionSchema
>;

export const feedbackConversationMessageAttentionSchema = z
  .object({
    categories: z
      .array(postEventFeedbackSafetyCategorySchema)
      .min(1)
      .max(POST_EVENT_FEEDBACK_SAFETY_CATEGORIES.length)
      .refine((categories) => new Set(categories).size === categories.length, {
        message: "Attention categories must be unique",
      }),
    recommendedAction: postEventFeedbackRecommendedActionSchema,
    confidence: z.number().min(0).max(1),
  })
  .strict();

export type FeedbackConversationMessageAttention = z.infer<
  typeof feedbackConversationMessageAttentionSchema
>;

/**
 * Why a conversation is asking for a person.
 *
 * `needsAttention` was a bare boolean, so five different situations arrived in
 * the inbox looking identical and the admin could not say what the problem was.
 * Naming the reason is what lets the operator read one and dismiss it — and
 * dismissing is per reason, so clearing a score somebody revised can never take
 * a disclosure down with it.
 *
 * Distinct from the safety taxonomy above, which classifies harm to a person.
 * `hostile_to_bot` is deliberately not a safety category: somebody swearing at
 * us is rude, not an incident, and folding it into the categories would start
 * flagging every participant who told the bot to get lost.
 */
export const POST_EVENT_FEEDBACK_ATTENTION_REASONS = [
  "safety",
  "handoff",
  "unattributed_note",
  "answer_revision",
  "hostile_to_bot",
] as const;

export const postEventFeedbackAttentionReasonSchema = z.enum(
  POST_EVENT_FEEDBACK_ATTENTION_REASONS,
);

export type PostEventFeedbackAttentionReason = z.infer<
  typeof postEventFeedbackAttentionReasonSchema
>;

/**
 * One reason, and the message an operator should be looking at.
 *
 * `messageId` is the anchor the admin links to. It is nullable because not
 * every reason has one: a safety signal and a hostile turn both name the
 * message that carried them, but a note flagged for review points at a note,
 * and a reason raised by a sweep points at nothing a participant sent.
 */
export const feedbackConversationAttentionReasonSchema = z
  .object({
    /**
     * Stable handle, so dismissing addresses one entry rather than a shape.
     * Two revisions of the same answer, or two hostile turns, are separate
     * things an operator may want to clear separately.
     */
    id: z.uuid(),
    kind: postEventFeedbackAttentionReasonSchema,
    messageId: z.uuid().nullable(),
    at: z.date(),
    /** Set when an operator dismisses it. Unresolved reasons are what count. */
    resolvedAt: z.date().nullable().default(null),
    resolvedBy: z.string().trim().min(1).max(200).nullable().default(null),
  })
  .strict()
  .superRefine((reason, context) => {
    if ((reason.resolvedAt === null) !== (reason.resolvedBy === null)) {
      context.addIssue({
        code: "custom",
        message: "A resolved attention reason records both when and by whom",
      });
    }
  });

export type FeedbackConversationAttentionReason = z.infer<
  typeof feedbackConversationAttentionReasonSchema
>;

const RECOMMENDED_ACTION_RANK: Record<
  PostEventFeedbackRecommendedAction,
  number
> = {
  review: 0,
  human_follow_up: 1,
  urgent_human_follow_up: 2,
};

export function strongerRecommendedAction(
  left: PostEventFeedbackRecommendedAction,
  right: PostEventFeedbackRecommendedAction,
): PostEventFeedbackRecommendedAction {
  return RECOMMENDED_ACTION_RANK[right] > RECOMMENDED_ACTION_RANK[left]
    ? right
    : left;
}
