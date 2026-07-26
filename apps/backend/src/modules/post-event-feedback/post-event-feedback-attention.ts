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
