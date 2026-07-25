import { createHash } from "node:crypto";

import { z } from "zod";

import {
  POST_EVENT_FEEDBACK_ANSWER_QUESTION_KEYS,
  POST_EVENT_FEEDBACK_QUESTION_SET_V1,
  type PostEventFeedbackQuestionSetCopy,
} from "../post-event-feedback/post-event-feedback-question-set.js";

// Schema v2 is the purpose-specific post-event feedback document. It shares the
// `conversation_threads` collection with the schema-v1 assistant aggregate and
// is discriminated by `schemaVersion` + `purpose`; neither reader reinterprets
// the other's documents.
export const FEEDBACK_CONVERSATION_SCHEMA_VERSION = 2 as const;
export const FEEDBACK_CONVERSATION_PURPOSE = "post_event_feedback" as const;
export const FEEDBACK_CONVERSATION_CHANNEL = "whatsapp" as const;
// WhatsApp accepts up to 4096 characters in a text message body.
export const FEEDBACK_CONVERSATION_MESSAGE_MAX_TEXT_LENGTH = 4_096;
// A feedback conversation is a short questionnaire. The message cap is the
// binding guard; the byte budget is the backstop for multi-byte-heavy content
// and stays far below MongoDB's 16 MiB BSON document limit.
export const FEEDBACK_CONVERSATION_MAX_MESSAGES = 150;
export const FEEDBACK_CONVERSATION_MAX_DOCUMENT_BYTES = 4_194_304;

export const feedbackConversationPhoneSchema = z
  .string()
  .trim()
  .regex(/^\+[1-9]\d{7,14}$/u, "Expected an E.164 phone number");

export const feedbackConversationLifecycleSchema = z
  .object({
    state: z.enum(["open", "closed"]),
    reason: z.enum(["completed", "stopped", "expired", "cancelled"]).nullable(),
    closedAt: z.date().nullable(),
  })
  .strict()
  .superRefine((lifecycle, context) => {
    if (
      lifecycle.state === "open" &&
      (lifecycle.reason || lifecycle.closedAt)
    ) {
      context.addIssue({
        code: "custom",
        message: "An open conversation cannot carry a terminal reason",
      });
    }
    if (
      lifecycle.state === "closed" &&
      (!lifecycle.reason || !lifecycle.closedAt)
    ) {
      context.addIssue({
        code: "custom",
        message: "A closed conversation requires a reason and closedAt",
      });
    }
  });

export const feedbackConversationControlSchema = z
  .object({
    mode: z.enum(["bot", "human"]),
    source: z.enum(["launch", "staff_action", "external_outbound"]),
    changedAt: z.date(),
  })
  .strict()
  .superRefine((control, context) => {
    if (control.mode === "human" && control.source === "launch") {
      context.addIssue({
        code: "custom",
        message: "Human control requires a staff action or external outbound",
      });
    }
  });

export const feedbackConversationGoalKeySchema = z.enum(
  POST_EVENT_FEEDBACK_ANSWER_QUESTION_KEYS,
);

export const feedbackConversationGoalSchema = z
  .object({
    key: feedbackConversationGoalKeySchema,
    ordinal: z.number().int().positive(),
    prompt: z.string().trim().min(1).max(500),
    status: z.enum(["pending", "asked", "answered", "skipped"]),
  })
  .strict();

export const feedbackConversationMessageSchema = z
  .object({
    id: z.uuid(),
    seq: z.number().int().positive(),
    actor: z.enum(["bot", "participant", "staff", "system"]),
    text: z
      .string()
      .trim()
      .min(1)
      .max(FEEDBACK_CONVERSATION_MESSAGE_MAX_TEXT_LENGTH),
    providerMessageId: z.string().trim().min(1).max(200).nullable(),
    ingressId: z.uuid().nullable(),
    outboxId: z.uuid().nullable(),
    at: z.date(),
  })
  .strict()
  .superRefine((message, context) => {
    if (message.actor === "participant" && !message.ingressId) {
      context.addIssue({
        code: "custom",
        message: "A participant message requires its durable ingress id",
      });
    }
    if (message.actor === "participant" && message.outboxId) {
      context.addIssue({
        code: "custom",
        message: "A participant message cannot originate from the outbox",
      });
    }
    if (message.actor === "bot" && !message.outboxId) {
      context.addIssue({
        code: "custom",
        message: "A bot message requires its outbox id",
      });
    }
    if (message.actor === "staff" && !message.outboxId && !message.ingressId) {
      context.addIssue({
        code: "custom",
        message:
          "A staff message requires an outbox id or an observed ingress id",
      });
    }
    if (message.actor === "system" && (message.outboxId || message.ingressId)) {
      context.addIssue({
        code: "custom",
        message: "A system message has no transport provenance",
      });
    }
  });

export const feedbackConversationExtractionSchema = z
  .object({
    cursorSeq: z.number().int().min(0),
    lastRunAt: z.date().nullable(),
    model: z.string().trim().min(1).max(200).nullable(),
  })
  .strict();

export const feedbackConversationDocumentSchema = z
  .object({
    _id: z.uuid(),
    schemaVersion: z.literal(FEEDBACK_CONVERSATION_SCHEMA_VERSION),
    purpose: z.literal(FEEDBACK_CONVERSATION_PURPOSE),
    channel: z.literal(FEEDBACK_CONVERSATION_CHANNEL),
    campaignId: z.uuid(),
    respondentParticipantId: z.uuid(),
    phoneAtLaunch: feedbackConversationPhoneSchema,
    lifecycle: feedbackConversationLifecycleSchema,
    control: feedbackConversationControlSchema,
    goals: z.array(feedbackConversationGoalSchema).min(1).max(10),
    messages: z
      .array(feedbackConversationMessageSchema)
      .max(FEEDBACK_CONVERSATION_MAX_MESSAGES),
    extraction: feedbackConversationExtractionSchema,
    needsAttention: z.boolean(),
    remindedAt: z.date().nullable(),
    createdAt: z.date(),
    updatedAt: z.date(),
  })
  .strict()
  .superRefine((conversation, context) => {
    if (conversation.updatedAt < conversation.createdAt) {
      context.addIssue({
        code: "custom",
        message: "Conversation updatedAt cannot precede createdAt",
      });
    }

    const goalKeys = new Set<string>();
    for (const [index, goal] of conversation.goals.entries()) {
      if (goalKeys.has(goal.key) || goal.ordinal !== index + 1) {
        context.addIssue({
          code: "custom",
          message:
            "Conversation goals require unique keys and contiguous ordered ordinals",
        });
        break;
      }
      goalKeys.add(goal.key);
    }

    const messageIds = new Set<string>();
    const provenanceIds = new Set<string>();
    for (const [index, message] of conversation.messages.entries()) {
      const provenance = [
        message.ingressId,
        message.outboxId,
        message.providerMessageId,
      ].filter((value): value is string => Boolean(value));
      if (
        messageIds.has(message.id) ||
        message.seq !== index + 1 ||
        message.at > conversation.updatedAt ||
        provenance.some((value) => provenanceIds.has(value))
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Conversation messages require unique ids, unique provenance, contiguous order and conversation-bounded timestamps",
        });
        break;
      }
      messageIds.add(message.id);
      for (const value of provenance) {
        provenanceIds.add(value);
      }
    }

    if (conversation.extraction.cursorSeq > conversation.messages.length) {
      context.addIssue({
        code: "custom",
        message: "The extraction cursor cannot pass the transcript",
      });
    }
  });

export type FeedbackConversationDocument = z.infer<
  typeof feedbackConversationDocumentSchema
>;
export type FeedbackConversationMessage = z.infer<
  typeof feedbackConversationMessageSchema
>;
export type FeedbackConversationGoal = z.infer<
  typeof feedbackConversationGoalSchema
>;
export type FeedbackConversationLifecycleReason = NonNullable<
  FeedbackConversationDocument["lifecycle"]["reason"]
>;
export type FeedbackConversationControlSource =
  FeedbackConversationDocument["control"]["source"];
export type FeedbackConversationActor = FeedbackConversationMessage["actor"];

/**
 * Builds the ordered goal set from the versioned WP0 question definitions. The
 * campaign owns the copy snapshot taken at launch; the keys and their order
 * stay owned by the question set.
 */
export function buildFeedbackConversationGoals(
  copy: PostEventFeedbackQuestionSetCopy = POST_EVENT_FEEDBACK_QUESTION_SET_V1.copy,
): FeedbackConversationGoal[] {
  return POST_EVENT_FEEDBACK_QUESTION_SET_V1.answerQuestions.map(
    (question, index) =>
      feedbackConversationGoalSchema.parse({
        key: question.key,
        ordinal: index + 1,
        prompt: copy[question.key],
        status: "pending",
      }),
  );
}

/**
 * Deterministic conversation identity: `uuidv5(campaignId, participantId)`.
 * Launch replay therefore collides on `_id` instead of creating a second
 * conversation, and at most one conversation per (campaign, participant) can
 * ever exist.
 */
export function deriveFeedbackConversationId(
  campaignId: string,
  respondentParticipantId: string,
): string {
  const namespace = z.uuid().parse(campaignId);
  const name = z.string().trim().min(1).parse(respondentParticipantId);
  return uuidV5(namespace, name);
}

function uuidV5(namespace: string, name: string): string {
  const digest = createHash("sha1")
    .update(uuidToBytes(namespace))
    .update(Buffer.from(name, "utf8"))
    .digest();
  const bytes = digest.subarray(0, 16);
  bytes.writeUInt8((bytes.readUInt8(6) & 0x0f) | 0x50, 6);
  bytes.writeUInt8((bytes.readUInt8(8) & 0x3f) | 0x80, 8);
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

function uuidToBytes(uuid: string): Buffer {
  return Buffer.from(uuid.replaceAll("-", ""), "hex");
}
