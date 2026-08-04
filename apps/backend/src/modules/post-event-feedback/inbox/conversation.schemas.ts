import {
  FEEDBACK_ANSWER_QUESTION_KEYS,
  FEEDBACK_CAMPAIGN_STATUSES,
  FEEDBACK_NOTE_STATUSES,
  FEEDBACK_NOTE_TYPES,
  MESSAGE_OUTBOX_DELIVERY_STATUSES,
  MESSAGE_OUTBOX_STATUSES,
} from "@join-the-six/database";
import { createZodDto } from "nestjs-zod";
import { z } from "zod";

import {
  correlationIdSchema,
  principalSchema,
} from "../../../infrastructure/auth/auth.schemas.js";
import {
  FEEDBACK_CONVERSATION_MAX_ATTENTION_REASONS,
  FEEDBACK_CONVERSATION_MESSAGE_MAX_STORED_TEXT_LENGTH,
  FEEDBACK_CONVERSATION_MESSAGE_MAX_TEXT_LENGTH,
  FEEDBACK_STAFF_CLOSE_NOTE_MAX_LENGTH,
  FEEDBACK_STAFF_CLOSE_REASONS,
  FEEDBACK_CONVERSATION_LIFECYCLE_REASONS,
} from "../post-event-feedback-conversation.document.js";
import {
  feedbackConversationMessageAttentionSchema,
  postEventFeedbackAttentionReasonSchema,
} from "../attention.js";
import { FEEDBACK_DIRECTED_ANSWER_QUESTION_KEYS } from "../question-set.js";

export const feedbackConversationCapabilitiesSchema = z
  .object({
    canTakeOver: z.boolean(),
    canResumeBot: z.boolean(),
    canClose: z.boolean(),
    canSendStaffMessage: z.boolean(),
  })
  .strict();

export const feedbackConversationGoalProgressSchema = z
  .object({
    key: z.enum(FEEDBACK_ANSWER_QUESTION_KEYS),
    ordinal: z.number().int().positive(),
    status: z.enum(["pending", "asked", "answered", "skipped"]),
  })
  .strict();

export const feedbackConversationListItemSchema = z
  .object({
    id: z.uuid(),
    campaignId: z.uuid(),
    respondentParticipantId: z.uuid(),
    respondentDisplayName: z.string().min(1).max(200).nullable(),
    phoneAtLaunch: z.string().min(1),
    lifecycle: z
      .object({
        state: z.enum(["open", "closed"]),
        reason: z.enum(FEEDBACK_CONVERSATION_LIFECYCLE_REASONS).nullable(),
      })
      .strict(),
    control: z
      .object({
        mode: z.enum(["bot", "human"]),
        source: z.enum(["launch", "staff_action", "external_outbound"]),
      })
      .strict(),
    goals: z.array(feedbackConversationGoalProgressSchema).max(10),
    messageCount: z.number().int().nonnegative(),
    lastMessageAt: z.iso.datetime().nullable(),
    lastMessageActor: z
      .enum(["bot", "participant", "staff", "system"])
      .nullable(),
    needsAttention: z.boolean(),
    remindedAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    capabilities: feedbackConversationCapabilitiesSchema,
  })
  .strict();

export const feedbackCampaignInboxSummarySchema = z
  .object({
    id: z.uuid(),
    eventId: z.uuid(),
    eventTitle: z.string().min(1).max(200).nullable(),
    status: z.enum(FEEDBACK_CAMPAIGN_STATUSES),
    questionSetVersion: z.number().int().positive(),
    launchedAt: z.iso.datetime(),
    conversationCount: z.number().int().nonnegative(),
    openCount: z.number().int().nonnegative(),
    needsAttentionCount: z.number().int().nonnegative(),
    /**
     * How many conversations are waiting on the model rather than on a person.
     *
     * The campaign-level report of a provider incident, and deliberately the
     * *only* place one is reported. A failed provider is one event — an exhausted
     * balance, an unreachable route, a model id nobody serves — so it belongs in
     * the campaign header beside the other counts, not as a badge on every row it
     * touched. Non-zero and rising means somebody should look at the deployment;
     * it falls on its own as the retries land.
     */
    extractionParkedCount: z.number().int().nonnegative(),
  })
  .strict();

export const feedbackCampaignConversationsSchema = z
  .object({
    campaign: feedbackCampaignInboxSummarySchema,
    conversations: z.array(feedbackConversationListItemSchema).max(500),
  })
  .strict();

export const feedbackConversationMessageDeliverySchema = z
  .object({
    outboxId: z.uuid(),
    outboxStatus: z.enum(MESSAGE_OUTBOX_STATUSES),
    deliveryStatus: z.enum(MESSAGE_OUTBOX_DELIVERY_STATUSES).nullable(),
    sentAt: z.iso.datetime().nullable(),
    deliveredAt: z.iso.datetime().nullable(),
    readAt: z.iso.datetime().nullable(),
    playedAt: z.iso.datetime().nullable(),
  })
  .strict();

export const feedbackConversationMessageSchema = z
  .object({
    id: z.uuid(),
    seq: z.number().int().positive(),
    actor: z.enum(["bot", "participant", "staff", "system"]),
    // The *stored* limit, not the send limit. These are the words somebody
    // actually wrote, replayed for an operator to read; what we are allowed to
    // say back is a different question and a different constant. Bounded by the
    // send limit, one 4,476-character message made the whole conversation
    // unopenable — a 500 on the detail endpoint — and people write their way up
    // to the hard thing, so the tail this refused to render is exactly where a
    // disclosure lives.
    text: z
      .string()
      .min(1)
      .max(FEEDBACK_CONVERSATION_MESSAGE_MAX_STORED_TEXT_LENGTH),
    providerMessageId: z.string().min(1).max(200).nullable(),
    ingressId: z.uuid().nullable(),
    outboxId: z.uuid().nullable(),
    attention: feedbackConversationMessageAttentionSchema.nullable(),
    at: z.iso.datetime(),
    delivery: feedbackConversationMessageDeliverySchema.nullable(),
  })
  .strict();

export const feedbackConversationGoalDetailSchema =
  feedbackConversationGoalProgressSchema
    .extend({
      prompt: z.string().min(1).max(500),
    })
    .strict();

/** Durable extraction results, independent of transient queue retention. */
export const feedbackConversationExtractionSchema = z
  .object({
    unreadParticipantMessages: z.number().int().nonnegative(),
    lastRunAt: z.iso.datetime().nullable(),
    model: z.string().min(1).max(200).nullable(),
  })
  .strict();

/**
 * Current durable automation state for one conversation.
 *
 * Scheduling comes from MongoDB's authoritative work revision. `running` is
 * admitted only by a live PostgreSQL execution lease. The response deliberately
 * publishes neither the lease token nor either store's execution epoch.
 */
export const feedbackConversationAutomationSchema = z
  .object({
    state: z.enum(["idle", "scheduled", "running", "parked"]),
    nextActionAt: z.iso.datetime().nullable(),
    revision: z.number().int().nonnegative(),
    claimExpiresAt: z.iso.datetime().nullable(),
  })
  .strict()
  .superRefine((automation, context) => {
    if (
      (automation.state === "running") !==
      (automation.claimExpiresAt !== null)
    ) {
      context.addIssue({
        code: "custom",
        message: "claimExpiresAt must be present only while automation runs",
        path: ["claimExpiresAt"],
      });
    }
  });

/**
 * Why this conversation is asking for a person, one entry per situation.
 *
 * `needsAttention` says only that something is wrong; this is what says what.
 * `messageId` is the anchor the detail pane links to, and is null for a reason
 * no single message caused. Resolved entries stay in the response — the pane
 * shows only the unresolved ones, but the list is the record of what was
 * raised and cleared, and hiding the cleared ones here would make a dismissal
 * indistinguishable from a reason that was never raised.
 */
export const feedbackConversationAttentionReasonSchema = z
  .object({
    id: z.uuid(),
    kind: postEventFeedbackAttentionReasonSchema,
    messageId: z.uuid().nullable(),
    at: z.iso.datetime(),
    resolvedAt: z.iso.datetime().nullable(),
    resolvedBy: z.string().min(1).max(200).nullable(),
  })
  .strict();

export const feedbackConversationDetailSchema = z
  .object({
    id: z.uuid(),
    campaignId: z.uuid(),
    respondentParticipantId: z.uuid(),
    respondentDisplayName: z.string().min(1).max(200).nullable(),
    phoneAtLaunch: z.string().min(1),
    lifecycle: z
      .object({
        state: z.enum(["open", "closed"]),
        reason: z.enum(FEEDBACK_CONVERSATION_LIFECYCLE_REASONS).nullable(),
        closedAt: z.iso.datetime().nullable(),
      })
      .strict(),
    control: z
      .object({
        mode: z.enum(["bot", "human"]),
        source: z.enum(["launch", "staff_action", "external_outbound"]),
        changedAt: z.iso.datetime(),
      })
      .strict(),
    goals: z.array(feedbackConversationGoalDetailSchema).max(10),
    messages: z.array(feedbackConversationMessageSchema).max(150),
    extraction: feedbackConversationExtractionSchema,
    automation: feedbackConversationAutomationSchema,
    /**
     * The bot has deliberately stopped and is waiting for an operator.
     *
     * This is independent of control mode: a safety handoff remains under bot
     * control until staff actually takes over, but no automatic reply may run
     * in the meantime. Publishing the fact keeps clients from inferring
     * activity from capability flags.
     */
    awaitingHuman: z.boolean(),
    needsAttention: z.boolean(),
    attentionReasons: z
      .array(feedbackConversationAttentionReasonSchema)
      .max(FEEDBACK_CONVERSATION_MAX_ATTENTION_REASONS),
    remindedAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    /**
     * Why a human closed this conversation. Null when the close was not a
     * staff action, or when the conversation predates staff close reasons.
     * The lifecycle reason stays `cancelled` either way — this is the operator
     * intent, not a state-machine value.
     */
    staffClose: z
      .object({
        reason: z.enum(FEEDBACK_STAFF_CLOSE_REASONS),
        note: z
          .string()
          .min(1)
          .max(FEEDBACK_STAFF_CLOSE_NOTE_MAX_LENGTH)
          .nullable(),
      })
      .strict()
      .nullable(),
    capabilities: feedbackConversationCapabilitiesSchema,
  })
  .strict();

/**
 * That a human decided this value, and who — not the correction's history.
 *
 * Derived from `extraction_meta`, on the same discipline as a note's `origin`:
 * the row's provenance blob does not go on the wire. The before/after and any
 * operator note live in `audit_events`, which is where "what did it used to say"
 * is answerable; publishing them here would put a second, editable history in
 * the read model. The model's own confidence score stays off the screen too —
 * a number an operator cannot calibrate invites them to trust it.
 */
export const feedbackAnswerCorrectionSchema = z
  .object({
    at: z.iso.datetime(),
    by: z.string().min(1).max(200),
  })
  .strict();

/**
 * Who authored a recorded result — an answer or a note — as a two-value fact the
 * admin can render.
 *
 * `conversation` covers everything the pipeline produced from participant
 * testimony: a model extraction and the deterministic fallback alike, since both
 * quote a real message. `staff` is an operator writing in their own name. The
 * distinction exists so what an operator asserted can never be read as something
 * a participant said, and it is the same distinction on both tables because it
 * is the same question.
 */
export const feedbackResultOriginSchema = z.enum(["conversation", "staff"]);

export const feedbackAnswerViewSchema = z
  .object({
    id: z.uuid(),
    campaignId: z.uuid(),
    conversationId: z.uuid(),
    questionKey: z.enum(FEEDBACK_ANSWER_QUESTION_KEYS),
    valueInt: z.number().int().min(1).max(5).nullable(),
    respondentParticipantId: z.uuid(),
    respondentDisplayName: z.string().min(1).max(200).nullable(),
    subjectParticipantId: z.uuid().nullable(),
    subjectDisplayName: z.string().min(1).max(200).nullable(),
    // An answer an operator recorded quotes no message, so the array is empty
    // rather than carrying a borrowed id. Extraction output still cites at
    // least one, and `origin` is what tells the two apart on the screen.
    sourceMessageIds: z.array(z.uuid()),
    origin: feedbackResultOriginSchema,
    correction: feedbackAnswerCorrectionSchema.nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

export const FEEDBACK_NOTE_TEXT_MAX_LENGTH = 500;

export const feedbackNoteOriginSchema = feedbackResultOriginSchema;

export const feedbackNoteViewSchema = z
  .object({
    id: z.uuid(),
    campaignId: z.uuid(),
    conversationId: z.uuid(),
    noteType: z.enum(FEEDBACK_NOTE_TYPES),
    text: z.string().min(1).max(FEEDBACK_NOTE_TEXT_MAX_LENGTH),
    status: z.enum(FEEDBACK_NOTE_STATUSES),
    origin: feedbackNoteOriginSchema,
    respondentParticipantId: z.uuid(),
    respondentDisplayName: z.string().min(1).max(200).nullable(),
    subjectParticipantId: z.uuid().nullable(),
    subjectDisplayName: z.string().min(1).max(200).nullable(),
    // A staff note quotes no message, so the array is empty rather than
    // carrying a borrowed id. Extraction output still cites at least one.
    sourceMessageIds: z.array(z.uuid()),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

export const feedbackConversationResultsSchema = z
  .object({
    answers: z.array(feedbackAnswerViewSchema),
    notes: z.array(feedbackNoteViewSchema),
  })
  .strict();

export const feedbackCampaignResultsQuerySchema = z
  .object({
    questionKey: z.enum(FEEDBACK_ANSWER_QUESTION_KEYS).optional(),
    participantId: z.uuid().optional(),
    reviewStatus: z.enum(FEEDBACK_NOTE_STATUSES).optional(),
  })
  .strict();

export const feedbackCampaignIdParamSchema = z
  .object({
    campaignId: z.uuid(),
  })
  .strict();

export const feedbackConversationIdParamSchema = z
  .object({
    campaignId: z.uuid(),
    conversationId: z.uuid(),
  })
  .strict();

export const feedbackAttentionReasonIdParamSchema = z
  .object({
    campaignId: z.uuid(),
    conversationId: z.uuid(),
    reasonId: z.uuid(),
  })
  .strict();

export const feedbackAnswerIdParamSchema = z
  .object({
    campaignId: z.uuid(),
    conversationId: z.uuid(),
    answerId: z.uuid(),
  })
  .strict();

export const feedbackNoteIdParamSchema = z
  .object({
    noteId: z.uuid(),
  })
  .strict();

export const sendFeedbackStaffMessageSchema = z
  .object({
    clientMessageId: z.uuid(),
    text: z
      .string()
      .trim()
      .min(1)
      .max(FEEDBACK_CONVERSATION_MESSAGE_MAX_TEXT_LENGTH),
  })
  .strict();

export function createFeedbackStaffMessageDedupeKey(
  conversationId: string,
  clientMessageId: string,
): string {
  return `feedback-staff-${conversationId}-${clientMessageId}`;
}

/**
 * Why the operator is ending this thread.
 *
 * Required: a close with no stated reason is the thing we are trying to stop —
 * a month later nobody could tell an abusive thread from one handled by phone,
 * because every human close landed as lifecycle `cancelled` with an empty
 * audit context. The note is free text for the operator's own record and is
 * optional; it never reaches the participant.
 */
export const closeFeedbackConversationSchema = z
  .object({
    reason: z.enum(FEEDBACK_STAFF_CLOSE_REASONS),
    note: z
      .string()
      .trim()
      .min(1)
      .max(FEEDBACK_STAFF_CLOSE_NOTE_MAX_LENGTH)
      .optional(),
  })
  .strict();

export const updateFeedbackNoteReviewStatusSchema = z
  .object({
    status: z.enum(FEEDBACK_NOTE_STATUSES),
  })
  .strict();

export const FEEDBACK_ANSWER_CORRECTION_NOTE_MAX_LENGTH = 500;

/**
 * An operator fixing a score the model read wrong.
 *
 * `valueInt` is required and bounded by the question set's own 1–5 range: this
 * route changes a number, and there is no "no value" to send. Withdrawing an
 * answer is a different assertion and a different verb — `value_int` is already
 * null on every `liked` / `meet_again` / `avoid` row, where the subject *is* the
 * answer, so a null here could not mean "withdrawn" without colliding with the
 * ordinary shape of three quarters of the table.
 *
 * The note is for the operator's reasoning and is recorded in the audit context
 * only. It never reaches the participant and is not published in the read model.
 */
export const correctFeedbackConversationAnswerSchema = z
  .object({
    valueInt: z.number().int().min(1).max(5),
    note: z
      .string()
      .trim()
      .min(1)
      .max(FEEDBACK_ANSWER_CORRECTION_NOTE_MAX_LENGTH)
      .optional(),
  })
  .strict();

/**
 * What a withdrawal answers with: the id that is gone.
 *
 * There is no row left to return, and the whole conversation's results are
 * re-read by the caller anyway. The withdrawn row survives in the audit context,
 * not here.
 */
export const feedbackAnswerWithdrawalSchema = z
  .object({
    id: z.uuid(),
  })
  .strict();

/**
 * An answer an operator records by hand about one person.
 *
 * Only a directed question: on `event_score` the answer is a number the
 * respondent gave, and an operator inventing one would be putting a rating in
 * their mouth. Here the assertion is «this person belongs under this question»,
 * which an operator can know from a phone call the thread never saw.
 *
 * The subject is required, and must be a current D16 candidate of the campaign's
 * event — the same rule extraction obeys and the same rule the staff note obeys,
 * so a recorded answer cannot direct feedback at someone the respondent never
 * sat with.
 */
export const addFeedbackConversationAnswerSchema = z
  .object({
    questionKey: z.enum(FEEDBACK_DIRECTED_ANSWER_QUESTION_KEYS),
    subjectParticipantId: z.uuid(),
  })
  .strict();

/**
 * A note an operator writes by hand. The subject is optional and, when given,
 * must be a current D16 candidate of the campaign's event — the same rule
 * extraction obeys, so a manual note cannot direct feedback at someone the
 * respondent never sat with.
 */
export const addFeedbackConversationNoteSchema = z
  .object({
    noteType: z.enum(FEEDBACK_NOTE_TYPES),
    text: z.string().trim().min(1).max(FEEDBACK_NOTE_TEXT_MAX_LENGTH),
    subjectParticipantId: z.uuid().optional(),
  })
  .strict();

export class FeedbackCampaignConversationsDto extends createZodDto(
  feedbackCampaignConversationsSchema,
) {}
export class FeedbackConversationDetailDto extends createZodDto(
  feedbackConversationDetailSchema,
) {}
export class FeedbackConversationResultsDto extends createZodDto(
  feedbackConversationResultsSchema,
) {}
export class FeedbackCampaignResultsQueryDto extends createZodDto(
  feedbackCampaignResultsQuerySchema,
) {}
export class FeedbackCampaignIdParamDto extends createZodDto(
  feedbackCampaignIdParamSchema,
) {}
export class FeedbackConversationIdParamDto extends createZodDto(
  feedbackConversationIdParamSchema,
) {}
export class FeedbackAttentionReasonIdParamDto extends createZodDto(
  feedbackAttentionReasonIdParamSchema,
) {}
export class FeedbackAnswerIdParamDto extends createZodDto(
  feedbackAnswerIdParamSchema,
) {}
export class FeedbackNoteIdParamDto extends createZodDto(
  feedbackNoteIdParamSchema,
) {}
export class CorrectFeedbackConversationAnswerDto extends createZodDto(
  correctFeedbackConversationAnswerSchema,
) {}
export class FeedbackAnswerViewDto extends createZodDto(
  feedbackAnswerViewSchema,
) {}
export class FeedbackAnswerWithdrawalDto extends createZodDto(
  feedbackAnswerWithdrawalSchema,
) {}
export class SendFeedbackStaffMessageDto extends createZodDto(
  sendFeedbackStaffMessageSchema,
) {}
export class CloseFeedbackConversationDto extends createZodDto(
  closeFeedbackConversationSchema,
) {}
export class UpdateFeedbackNoteReviewStatusDto extends createZodDto(
  updateFeedbackNoteReviewStatusSchema,
) {}
export class AddFeedbackConversationNoteDto extends createZodDto(
  addFeedbackConversationNoteSchema,
) {}
export class AddFeedbackConversationAnswerDto extends createZodDto(
  addFeedbackConversationAnswerSchema,
) {}
export class FeedbackNoteViewDto extends createZodDto(feedbackNoteViewSchema) {}

export type FeedbackConversationCapabilities = z.infer<
  typeof feedbackConversationCapabilitiesSchema
>;
export type FeedbackConversationExtractionView = z.infer<
  typeof feedbackConversationExtractionSchema
>;
export type FeedbackConversationAutomationView = z.infer<
  typeof feedbackConversationAutomationSchema
>;
export type FeedbackCampaignConversationsView = z.infer<
  typeof feedbackCampaignConversationsSchema
>;
export type FeedbackConversationDetailView = z.infer<
  typeof feedbackConversationDetailSchema
>;
export type FeedbackConversationAttentionReasonView = z.infer<
  typeof feedbackConversationAttentionReasonSchema
>;
export type FeedbackConversationResultsView = z.infer<
  typeof feedbackConversationResultsSchema
>;
export type FeedbackCampaignResultsQuery = z.infer<
  typeof feedbackCampaignResultsQuerySchema
>;
export type SendFeedbackStaffMessageInput = z.infer<
  typeof sendFeedbackStaffMessageSchema
>;
export type CloseFeedbackConversationInput = z.infer<
  typeof closeFeedbackConversationSchema
>;
export type UpdateFeedbackNoteReviewStatusInput = z.infer<
  typeof updateFeedbackNoteReviewStatusSchema
>;
export type AddFeedbackConversationNoteInput = z.infer<
  typeof addFeedbackConversationNoteSchema
>;
export type AddFeedbackConversationAnswerInput = z.infer<
  typeof addFeedbackConversationAnswerSchema
>;
export type CorrectFeedbackConversationAnswerInput = z.infer<
  typeof correctFeedbackConversationAnswerSchema
>;
export type FeedbackAnswerView = z.infer<typeof feedbackAnswerViewSchema>;
export type FeedbackAnswerWithdrawalView = z.infer<
  typeof feedbackAnswerWithdrawalSchema
>;
export type FeedbackNoteView = z.infer<typeof feedbackNoteViewSchema>;
export type FeedbackNoteOrigin = z.infer<typeof feedbackNoteOriginSchema>;
export type FeedbackConversationPrincipal = z.infer<typeof principalSchema>;
export type FeedbackConversationCorrelationId = z.infer<
  typeof correlationIdSchema
>;
