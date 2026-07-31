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
  /**
   * The message in front of you degrades, slurs or dehumanises a named
   * attendee. No reported incident is required — the message is the incident.
   *
   * Every other name here classifies harm somebody told us about, which left
   * the taxonomy with nothing to say when the harm was in the testimony itself.
   * Γεωργία Ρατσιστρόνα answered `avoid` with «δεν καθομαι με ξενους στο ιδιο
   * τραπεζι» about a woman she named, and the classifier answered no incident:
   * nothing had been described. `other_safety` was the only bucket that would
   * have taken it, and reaching it required overriding the prompt.
   *
   * Named for what the message does, not for who is doing it — `self_harm` and
   * `violence_or_threat` name the harm too, never the speaker. Deliberately
   * broader than a discrimination category, because the gap is "the respondent
   * is the source": name only the racist case and «η Στέλλα είναι μια χοντρή
   * αγελάδα, μακριά της» still raises nothing. Protected-characteristic abuse
   * is the clearest instance and always qualifies; if it ever needs its own
   * reporting line it can be split out then.
   */
  "abuse_of_a_participant",
  "other_safety",
] as const;

export const postEventFeedbackSafetyCategorySchema = z.enum(
  POST_EVENT_FEEDBACK_SAFETY_CATEGORIES,
);

export type PostEventFeedbackSafetyCategory = z.infer<
  typeof postEventFeedbackSafetyCategorySchema
>;

/**
 * The categories where the person we are talking to is the one causing the harm.
 *
 * A set rather than a comparison because two consumers have to agree about it —
 * the reason an operator sees and the assurance line the participant is sent —
 * and because the second of these categories is what will make the direction a
 * field on the signal instead of a lookup. One value is not yet an axis.
 */
export const RESPONDENT_SOURCE_SAFETY_CATEGORIES: ReadonlySet<PostEventFeedbackSafetyCategory> =
  new Set(["abuse_of_a_participant"]);

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
 * `needsAttention` was a bare boolean, so a dozen different situations arrived
 * in the inbox looking identical and the admin could not say what the problem
 * was. Naming the reason is what lets the operator read one and dismiss it —
 * and dismissing is per reason, so clearing a score somebody revised can never
 * take a disclosure down with it.
 *
 * The vocabulary is deliberately smaller than the list of places that raise:
 * two situations share a name whenever the operator does the same thing about
 * them. A truncated render and an edited redelivery are both «the transcript is
 * not what arrived, go and read the original», and a send that failed for good
 * and one that was too long to record are both «this never reached them». The
 * name is the operator's job, not the code path that noticed.
 *
 * Distinct from the safety taxonomy above, which classifies harm to a person.
 * `hostile_to_bot` is deliberately not a safety category: somebody swearing at
 * us is rude, not an incident, and folding it into the categories would start
 * flagging every participant who told the bot to get lost. It is raised by the
 * hostility ladder and by nothing else — never by the withdrawal path, because
 * prompt rule 7δ withdraws after two or three unanswered attempts and says in as
 * many words that somebody who swears has not refused, so reading a withdrawal
 * as hostility would be inventing exactly the classifier this comment refuses.
 *
 * `respondent_conduct` is the near neighbour that is *not* `hostile_to_bot` and
 * not plain `safety`. Swearing at us costs nobody anything; abusing somebody at
 * the table lands on that person's seating. And where `safety` means «protect
 * the person who wrote to us», this one means «the person who wrote to us is
 * the problem», which is a different next move for whoever opens the row — so
 * it gets its own name rather than sharing one.
 */
export const POST_EVENT_FEEDBACK_ATTENTION_REASONS = [
  "safety",
  /** The person we are talking to is the source, so the follow-up is on them. */
  "respondent_conduct",
  "handoff",
  "unattributed_note",
  "answer_revision",
  "hostile_to_bot",
  /** The bot stopped asking with goals still unanswered. */
  "unfinished_questionnaire",
  /** No model run survived; a deterministic fallback stood in for it. */
  "extraction_failed",
  /** An inbound arrived with nothing we can transcribe — voice note, media. */
  "unreadable_message",
  /** The stored turn is not a faithful copy: cut short, or edited in place. */
  "transcript_mismatch",
  /** The transcript is full, so nothing more can be recorded here. */
  "transcript_full",
  /** Something the bot was going to say will never reach the participant. */
  "undelivered_message",
  /** Somebody wrote after their conversation had closed. */
  "post_closure_message",
  /** A STOP from somebody who had answered nothing at all. */
  "stopped_without_answers",
  /**
   * The participant asked what we do with their data, and nobody has decided
   * the answer yet.
   *
   * Raised by the policy-question classifier for the questions
   * `policy-answers.ts` recognises but deliberately leaves unanswered —
   * retention, anonymity, and anything that matches no entry. The operator's
   * job is its own: answer the person yourself, and the question feeds the
   * approved-answers list so the next asker gets a sentence instead of a
   * deferral. Not `handoff` — no human was requested and none promised — and
   * not `unattributed_note`: nothing here is a note.
   */
  "unanswered_data_question",
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
