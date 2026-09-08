import { createHash } from "node:crypto";

import { z } from "zod";

import { FEEDBACK_ANSWER_QUESTION_KEYS } from "@slopform/database";

import { ConversationPersistenceError } from "../conversations/conversation-persistence.errors.js";
import {
  feedbackConversationAttentionReasonSchema,
  feedbackConversationMessageAttentionSchema,
} from "./attention.js";
import {
  CURRENT_POST_EVENT_FEEDBACK_QUESTION_SET_VERSION,
  getPostEventFeedbackQuestionSet,
  type PostEventFeedbackQuestionSetCopy,
  type PostEventFeedbackQuestionSetVersion,
} from "./question-set.js";

// Versioned feedback aggregate shared by PostgreSQL storage and legacy import.
export const FEEDBACK_CONVERSATION_SCHEMA_VERSION = 2 as const;
export const FEEDBACK_CONVERSATION_PURPOSE = "post_event_feedback" as const;
export const FEEDBACK_CONVERSATION_CHANNEL = "whatsapp" as const;
/** Longest body we will send (WhatsApp text limit). */
export const FEEDBACK_CONVERSATION_MESSAGE_MAX_TEXT_LENGTH = 4_096;

/**
 * Longest transcript body. Above the send limit so inbound tails are not cut
 * at the edge. Document size is guarded separately by the byte budget.
 */
export const FEEDBACK_CONVERSATION_MESSAGE_MAX_STORED_TEXT_LENGTH = 64_000;
// Transcript bounds are enforced before append and by PostgreSQL constraints.
export const FEEDBACK_CONVERSATION_MAX_MESSAGES = 150;
export const FEEDBACK_CONVERSATION_MAX_MESSAGES_BYTES = 4_194_304;
// Reason-list ceiling so a repeated raise cannot grow the document without limit.
export const FEEDBACK_CONVERSATION_MAX_ATTENTION_REASONS = 50;

export const feedbackConversationPhoneSchema = z
  .string()
  .trim()
  .regex(/^\+[1-9]\d{7,14}$/u, "Expected an E.164 phone number");

/**
 * Terminal reason. `completed` is a finished questionnaire with answers;
 * `declined` is a civil refusal with none (not STOP); `stopped` is consent;
 * `expired` is the sweep; `cancelled` is staff.
 */
export const FEEDBACK_CONVERSATION_LIFECYCLE_REASONS = [
  "completed",
  "declined",
  "stopped",
  "expired",
  "cancelled",
] as const;

export const feedbackConversationLifecycleSchema = z
  .object({
    state: z.enum(["open", "closed"]),
    reason: z.enum(FEEDBACK_CONVERSATION_LIFECYCLE_REASONS).nullable(),
    closedAt: z.date().nullable(),
    /**
     * Exact outbox row authorized by the terminal close. Other queued rows
     * cannot become a second goodbye. Null on expiry/cancel and old documents.
     */
    terminalOutboxId: z.uuid().nullable().optional(),
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
    if (
      lifecycle.terminalOutboxId &&
      (lifecycle.state !== "closed" ||
        (lifecycle.reason !== "completed" &&
          lifecycle.reason !== "declined" &&
          lifecycle.reason !== "stopped"))
    ) {
      context.addIssue({
        code: "custom",
        message:
          "A terminal outbox id belongs only to a completed, declined or stopped lifecycle",
      });
    }
  });

/**
 * Staff-close intent. Not folded into `lifecycle.reason` (every staff close is
 * `cancelled`). Cleared when STOP overrides a softer close.
 */
export const FEEDBACK_STAFF_CLOSE_REASONS = [
  "abusive",
  "unresponsive",
  "handled_offline",
  "duplicate",
  "other",
] as const;

export const FEEDBACK_STAFF_CLOSE_NOTE_MAX_LENGTH = 500;

export const feedbackConversationStaffCloseSchema = z
  .object({
    reason: z.enum(FEEDBACK_STAFF_CLOSE_REASONS),
    note: z
      .string()
      .trim()
      .min(1)
      .max(FEEDBACK_STAFF_CLOSE_NOTE_MAX_LENGTH)
      .nullable(),
  })
  .strict();

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
  FEEDBACK_ANSWER_QUESTION_KEYS,
);

export const feedbackConversationGoalSchema = z
  .object({
    key: feedbackConversationGoalKeySchema,
    ordinal: z.number().int().positive(),
    prompt: z.string().trim().min(1).max(500),
    status: z.enum(["pending", "asked", "answered", "skipped"]),
  })
  .strict();

export const feedbackConversationStoredMessageSchema = z
  .object({
    id: z.uuid(),
    seq: z.number().int().positive(),
    actor: z.enum(["bot", "participant", "staff", "system"]),
    text: z
      .string()
      .trim()
      .min(1)
      .max(FEEDBACK_CONVERSATION_MESSAGE_MAX_STORED_TEXT_LENGTH),
    providerMessageId: z.string().trim().min(1).max(200).nullable(),
    ingressId: z.uuid().nullable(),
    outboxId: z.uuid().nullable(),
    /** Optional-on-read; new appends always persist attention. */
    attention: feedbackConversationMessageAttentionSchema
      .nullable()
      .default(null),
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
    if (message.actor !== "participant" && message.attention) {
      context.addIssue({
        code: "custom",
        message: "Only participant messages can carry attention metadata",
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

/**
 * Accumulated extraction usage. A missing component stays null on the total —
 * that is "cost unavailable", not a smaller bill.
 */
export const feedbackConversationExtractionUsageSchema = z
  .object({
    inputTokens: z.number().int().min(0).nullable(),
    outputTokens: z.number().int().min(0).nullable(),
    totalTokens: z.number().int().min(0).nullable(),
  })
  .strict();

export const feedbackConversationExtractionSchema = z
  .object({
    cursorSeq: z.number().int().min(0),
    lastRunAt: z.date().nullable(),
    model: z.string().trim().min(1).max(200).nullable(),
    /**
     * Accumulated tokens, or null before the first model run. Durable (unlike
     * process-local metrics). Defaulted for pre-field documents.
     */
    usage: feedbackConversationExtractionUsageSchema.nullable().default(null),
    /**
     * Last-run service tier, last-write-wins. Plain string so an enum change
     * cannot unparse the document. Null means standard pricing.
     */
    serviceTier: z.string().trim().min(1).max(50).nullable().default(null),
    /**
     * First park on a provider incident. Not attention and not `awaitingHuman`.
     * Timestamp clocks the notice and the retry ceiling.
     */
    parkedSince: z.date().nullable().default(null),
    /**
     * How many runs have parked since `parkedSince`. The reconciler uses this to
     * report retry progress without relying on retained queue rows.
     */
    parkedRuns: z.number().int().min(0).default(0),
    /**
     * Park notice sent once. Not cleared when extraction recovers.
     */
    parkedNoticeSentAt: z.date().nullable().default(null),
  })
  .strict();

/**
 * Durable work intent. PostgreSQL owns due/revision on the conversation
 * row. `executionEpoch` is derived from the joined execution fence and is
 * not stored on the conversation. Optional on read for older documents.
 */
export const feedbackConversationWorkSchema = z
  .object({
    /** Monotonic version of the durable work requested for this aggregate. */
    revision: z.number().int().min(0),
    /** Earliest time the current revision should be reconciled, or no intent. */
    nextActionAt: z.date().nullable(),
    /** Joined fence epoch when a fence row exists; 0 only if never claimed. */
    executionEpoch: z.number().int().min(0),
    /**
     * Derived from `feedback_campaigns.resume_generation`. Not stored on
     * the conversation row. Optional on older in-memory documents.
     */
    campaignResumeGeneration: z.number().int().min(0).optional(),
  })
  .strict();

export type FeedbackConversationWork = z.infer<
  typeof feedbackConversationWorkSchema
>;

export function resolveFeedbackConversationWork(
  work: FeedbackConversationWork | undefined,
): FeedbackConversationWork {
  return work ?? { revision: 0, nextActionAt: null, executionEpoch: 0 };
}

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
      .array(feedbackConversationStoredMessageSchema)
      .max(FEEDBACK_CONVERSATION_MAX_MESSAGES),
    extraction: feedbackConversationExtractionSchema,
    /** Optional-on-read bridge; every new conversation writes it explicitly. */
    work: feedbackConversationWorkSchema.optional(),
    needsAttention: z.boolean(),
    /**
     * Named reasons, newest last. `needsAttention` is true iff some entry is
     * unresolved. Defaulted for pre-list documents.
     */
    attentionReasons: z
      .array(feedbackConversationAttentionReasonSchema)
      .max(FEEDBACK_CONVERSATION_MAX_ATTENTION_REASONS)
      .default([]),
    /** When the most recent nudge was queued. `null` until the first one. */
    remindedAt: z.date().nullable(),
    /**
     * Reminder ledger, capped by `FEEDBACK_MAX_REMINDERS`. `remindedAt` alone
     * cannot express a second rung.
     */
    reminderCount: z.number().int().min(0).max(10).default(0),
    /**
     * Bot is silent pending a person (handoff, urgent safety, withdrawal,
     * hostility stop). Not human control (D17) and not `needsAttention`.
     * Cleared on take-over or resume.
     */
    awaitingHuman: z.boolean().default(false),
    /**
     * Hostile runs (not messages). Safety-bearing runs never tick. Not derived
     * from `hostile_to_bot` reasons — dismissing a badge must not restore voice.
     */
    hostileTurns: z
      .number()
      .int()
      .min(0)
      .max(FEEDBACK_CONVERSATION_MAX_MESSAGES)
      .default(0),
    /**
     * Fallback ack already sent. Not cleared on recovery; later dead runs stay
     * silent.
     */
    extractionFallbackAckSent: z.boolean().default(false),
    /**
     * Staff-close why. Null on bot closes. Cleared when STOP overrides. Optional
     * on read; writers set it explicitly.
     */
    staffClose: feedbackConversationStaffCloseSchema.nullable().optional(),
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
    const sequences = new Set<number>();
    for (const message of conversation.messages) {
      const provenance = [
        message.ingressId,
        message.outboxId,
        message.providerMessageId,
      ].filter((value): value is string => Boolean(value));
      // `seq` is contiguous 1..N arrival order (cursor). Array order is
      // observation time. Do not bind them — out-of-order webhooks stay readable.
      if (
        messageIds.has(message.id) ||
        sequences.has(message.seq) ||
        message.seq > conversation.messages.length ||
        message.at > conversation.updatedAt ||
        provenance.some((value) => provenanceIds.has(value))
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Conversation messages require unique ids, unique provenance, contiguous sequence numbers and conversation-bounded timestamps",
        });
        break;
      }
      sequences.add(message.seq);
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
  typeof feedbackConversationStoredMessageSchema
>;
export type FeedbackConversationGoal = z.infer<
  typeof feedbackConversationGoalSchema
>;
export type FeedbackConversationLifecycleReason = NonNullable<
  FeedbackConversationDocument["lifecycle"]["reason"]
>;
export type FeedbackConversationStaffClose = NonNullable<
  NonNullable<FeedbackConversationDocument["staffClose"]>
>;
export type FeedbackConversationStaffCloseReason =
  FeedbackConversationStaffClose["reason"];
export type FeedbackConversationControlSource =
  FeedbackConversationDocument["control"]["source"];
export type FeedbackConversationExtractionUsage = z.infer<
  typeof feedbackConversationExtractionUsageSchema
>;

/**
 * Usage accumulation. First report becomes the total. After that, null is
 * absorbing in both directions — a gap is cost unavailable, not a smaller bill.
 */
export function accumulateFeedbackExtractionUsage(
  stored: FeedbackConversationExtractionUsage | null,
  reported: FeedbackConversationExtractionUsage,
): FeedbackConversationExtractionUsage {
  if (!stored) {
    return { ...reported };
  }
  return {
    inputTokens: addReportedTokens(stored.inputTokens, reported.inputTokens),
    outputTokens: addReportedTokens(stored.outputTokens, reported.outputTokens),
    totalTokens: addReportedTokens(stored.totalTokens, reported.totalTokens),
  };
}

function addReportedTokens(
  prior: number | null,
  reported: number | null,
): number | null {
  return prior === null || reported === null ? null : prior + reported;
}
export type FeedbackConversationActor = FeedbackConversationMessage["actor"];

/**
 * Goals from the versioned question set. Launch copy snapshot owns wording.
 */
export function buildFeedbackConversationGoals(
  copy?: PostEventFeedbackQuestionSetCopy,
  questionSetVersion: PostEventFeedbackQuestionSetVersion = CURRENT_POST_EVENT_FEEDBACK_QUESTION_SET_VERSION,
): FeedbackConversationGoal[] {
  const questionSet = getPostEventFeedbackQuestionSet(questionSetVersion);
  const resolvedCopy = copy ?? questionSet.copy;
  return questionSet.answerQuestions.map((question, index) => ({
    key: question.key,
    ordinal: index + 1,
    prompt: resolvedCopy[question.key],
    status: "pending" as const,
  }));
}

/**
 * Deterministic `_id`: `uuidv5(campaignId, participantId)`. Launch replay
 * collides instead of creating a second conversation.
 */
export function deriveFeedbackConversationId(
  campaignId: string,
  respondentParticipantId: string,
): string {
  const namespace = campaignId;
  const name = respondentParticipantId.trim();
  return uuidV5(namespace, name);
}

/**
 * Stable identity for the one acknowledgement owed by this conversation.
 */
export function deriveFeedbackStopAckOutboxId(conversationId: string): string {
  return uuidV5(conversationId, "feedback-stop-ack");
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

export const feedbackConversationSummarySchema = z
  .object({
    _id: z.uuid(),
    campaignId: z.uuid(),
    respondentParticipantId: z.uuid(),
    phoneAtLaunch: z.string().trim().min(1),
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
    goals: z.array(
      z
        .object({
          key: z.string().trim().min(1),
          ordinal: z.number().int().positive(),
          status: z.enum(["pending", "asked", "answered", "skipped"]),
        })
        .strict(),
    ),
    messageCount: z.number().int().min(0),
    lastMessageAt: z.date().nullable(),
    lastMessageActor: z
      .enum(["bot", "participant", "staff", "system"])
      .nullable(),
    cursorSeq: z.number().int().min(0),
    needsAttention: z.boolean(),
    /** Parked on a provider incident. Campaign summary counts these once. */
    extractionParked: z.boolean(),
    remindedAt: z.date().nullable(),
    createdAt: z.date(),
    updatedAt: z.date(),
  })
  .strict();

export type FeedbackConversationSummary = z.infer<
  typeof feedbackConversationSummarySchema
>;

/** Compact respondent projection for outbound-queue name resolution. */
export const feedbackConversationRespondentSchema = z
  .object({
    _id: z.uuid(),
    respondentParticipantId: z.uuid(),
    phoneAtLaunch: z.string().trim().min(1),
  })
  .strict();

export type FeedbackConversationRespondent = z.infer<
  typeof feedbackConversationRespondentSchema
>;

/**
 * Monotonic ranks. `answered` never demotes (D16). `skipped → asked` is the
 * one deliberate demotion (hold question).
 */
const GOAL_STATUS_RANK: Record<FeedbackConversationGoal["status"], number> = {
  pending: 0,
  asked: 1,
  skipped: 2,
  answered: 3,
};

/**
 * Observation time, then arrival sequence for ties.
 */
export function sortTranscript(
  messages: readonly FeedbackConversationMessage[],
): FeedbackConversationMessage[] {
  return [...messages].sort(
    (left, right) =>
      left.at.getTime() - right.at.getTime() || left.seq - right.seq,
  );
}

export function goalStatusRank(
  status: FeedbackConversationGoal["status"],
): number {
  return GOAL_STATUS_RANK[status];
}

/**
 * Rank-up always. Sole demotion is `skipped → asked`. `answered` never demotes.
 */
export function canTransitionGoalStatus(
  from: FeedbackConversationGoal["status"],
  to: FeedbackConversationGoal["status"],
): boolean {
  if (from === to) {
    return false;
  }
  if (from === "skipped" && to === "asked") {
    return true;
  }
  return goalStatusRank(to) > goalStatusRank(from);
}

export interface AppendFeedbackConversationMessageInput {
  readonly conversationId: string;
  readonly actor: FeedbackConversationActor;
  readonly text: string;
  readonly at: Date;
  readonly id?: string;
  readonly providerMessageId?: string | null;
  readonly ingressId?: string | null;
  readonly outboxId?: string | null;
}

export function messageIdentityKeys(message: {
  readonly id?: string | undefined;
  readonly ingressId?: string | null | undefined;
  readonly outboxId?: string | null | undefined;
}): string[] {
  return [message.id, message.ingressId, message.outboxId].filter(
    (value): value is string => Boolean(value),
  );
}

export function assertMessageIdentity(
  existing: FeedbackConversationMessage,
  replayed: AppendFeedbackConversationMessageInput,
): void {
  if (
    existing.actor !== replayed.actor ||
    existing.text !== replayed.text.trim()
  ) {
    throw new ConversationPersistenceError(
      "A feedback conversation message was replayed with different content",
    );
  }
}
