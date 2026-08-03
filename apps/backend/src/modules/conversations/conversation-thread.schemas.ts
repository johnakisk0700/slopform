import { z } from "zod";

export const CONVERSATION_THREAD_SCHEMA_VERSION = 1 as const;
export const CONVERSATION_THREAD_COLLECTION = "conversation_threads";
export const CONVERSATION_MESSAGE_MAX_CONTENT_LENGTH = 20_000;
// The aggregate embeds turns. Seventy-five maximum-size UTF-8 exchanges stay
// below MongoDB's 16 MiB BSON document ceiling with room for BSON metadata.
export const CONVERSATION_THREAD_MAX_TURNS = 75;

export const conversationPurposeSchema = z.enum([
  "admin_assistant",
  "post_event_feedback",
]);
export const conversationChannelSchema = z.enum(["admin", "whatsapp"]);
export const conversationOwnerSchema = z
  .object({
    type: z.enum(["staff", "participant"]),
    id: z.string().trim().min(1).max(200),
  })
  .strict();
export const conversationStateSchema = z.enum([
  "active",
  "completed",
  "human_takeover",
  "cancelled",
]);
export const conversationGoalSchema = z
  .object({
    key: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9][a-z0-9._-]*$/u),
    ordinal: z.number().int().positive(),
    prompt: z.string().trim().min(1).max(500),
    status: z.enum(["pending", "answered", "skipped"]),
    answer: z.string().trim().min(1).max(4_000).nullable(),
    updatedAt: z.date().nullable(),
  })
  .strict()
  .superRefine((goal, context) => {
    if (goal.status === "answered" && !goal.answer) {
      context.addIssue({
        code: "custom",
        message: "An answered conversation goal requires an answer",
      });
    }
    if (goal.status !== "answered" && goal.answer) {
      context.addIssue({
        code: "custom",
        message: "Only an answered conversation goal may contain an answer",
      });
    }
  });
export const conversationHumanTakeoverSchema = z
  .object({
    status: z.enum(["inactive", "requested", "active", "resolved"]),
    requestedAt: z.date().nullable(),
    resolvedAt: z.date().nullable(),
  })
  .strict()
  .superRefine((takeover, context) => {
    if (takeover.status === "inactive") {
      if (takeover.requestedAt || takeover.resolvedAt) {
        context.addIssue({
          code: "custom",
          message: "An inactive takeover cannot contain timestamps",
        });
      }
      return;
    }

    if (!takeover.requestedAt) {
      context.addIssue({
        code: "custom",
        message: "A requested takeover requires requestedAt",
      });
    }
    if (takeover.status === "resolved" && !takeover.resolvedAt) {
      context.addIssue({
        code: "custom",
        message: "A resolved takeover requires resolvedAt",
      });
    }
    if (takeover.status !== "resolved" && takeover.resolvedAt) {
      context.addIssue({
        code: "custom",
        message: "Only a resolved takeover may contain resolvedAt",
      });
    }
    if (
      takeover.requestedAt &&
      takeover.resolvedAt &&
      takeover.resolvedAt < takeover.requestedAt
    ) {
      context.addIssue({
        code: "custom",
        message: "A takeover cannot resolve before it was requested",
      });
    }
  });

export const conversationMessageSchema = z
  .object({
    actor: z.enum(["admin", "participant", "assistant", "system"]),
    content: z
      .string()
      .trim()
      .min(1)
      .max(CONVERSATION_MESSAGE_MAX_CONTENT_LENGTH),
  })
  .strict();
export const conversationTurnErrorSchema = z
  .object({
    code: z.string().trim().min(1).max(64),
    message: z.string().trim().min(1).max(500),
  })
  .strict();

export const conversationTurnToolCallSchema = z
  .object({
    toolCallId: z.string().trim().min(1).max(200),
    tool: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9_]+$/u),
    label: z.string().trim().min(1).max(100),
    state: z.enum(["running", "done", "failed"]),
    input: z.json().nullable(),
    output: z.json().nullable(),
    inputTruncated: z.boolean(),
    outputTruncated: z.boolean(),
  })
  .strict();

export const conversationTurnUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative().nullable(),
    outputTokens: z.number().int().nonnegative().nullable(),
    reasoningTokens: z.number().int().nonnegative().nullable(),
    cachedInputTokens: z.number().int().nonnegative().nullable(),
    totalTokens: z.number().int().nonnegative().nullable(),
    estimatedCostEurMicros: z.number().int().nonnegative().nullable(),
    pricingVersion: z.string().trim().min(1).max(32).nullable(),
  })
  .strict()
  .superRefine((usage, context) => {
    if (
      (usage.estimatedCostEurMicros === null) !==
      (usage.pricingVersion === null)
    ) {
      context.addIssue({
        code: "custom",
        message: "Estimated cost and pricing version must be recorded together",
      });
    }
  });

export const conversationTurnSchema = z
  .object({
    id: z.uuid(),
    requestId: z.uuid().nullable(),
    sequence: z.number().int().positive(),
    status: z.enum(["queued", "running", "succeeded", "failed"]),
    attempt: z.number().int().positive(),
    model: z.string().trim().min(1).max(200).nullable(),
    reasoningEffort: z.string().trim().min(1).max(32).nullable(),
    /**
     * The provider service tier the turn ran under. Defaulted so turns written
     * before the fast lane existed parse as the standard tier they in fact ran
     * under, rather than failing validation.
     */
    serviceTier: z.string().trim().min(1).max(32).nullable().default(null),
    input: conversationMessageSchema,
    output: conversationMessageSchema.nullable(),
    /**
     * Text streamed so far by the in-flight attempt. Defaulted so turns written
     * before streaming existed still parse, and kept apart from `output` because
     * only `output` is an answer — see
     * `docs/backend/mechanisms/assistant-streaming.md`.
     */
    partial: z.string().max(20_000).nullable().default(null),
    /** The provider's thinking for this attempt, retained after settlement. */
    reasoning: z.string().max(20_000).nullable().default(null),
    /** Bounded tool traces; optional only for documents written before support. */
    toolCalls: z.array(conversationTurnToolCallSchema).max(20).optional(),
    /** Final SDK usage and its dated estimate; absent on legacy/in-flight turns. */
    usage: conversationTurnUsageSchema.nullable().optional(),
    error: conversationTurnErrorSchema.nullable(),
    createdAt: z.date(),
    startedAt: z.date().nullable(),
    completedAt: z.date().nullable(),
  })
  .strict()
  .superRefine((turn, context) => {
    if (turn.status === "running" && !turn.startedAt) {
      context.addIssue({
        code: "custom",
        message: "A running conversation turn requires startedAt",
      });
    }
    if (turn.startedAt && turn.startedAt < turn.createdAt) {
      context.addIssue({
        code: "custom",
        message: "A conversation turn cannot start before it was created",
      });
    }
    if (
      turn.completedAt &&
      turn.completedAt < (turn.startedAt ?? turn.createdAt)
    ) {
      context.addIssue({
        code: "custom",
        message: "A conversation turn cannot complete before it started",
      });
    }

    if (
      turn.partial !== null &&
      (turn.status === "succeeded" || turn.status === "failed")
    ) {
      context.addIssue({
        code: "custom",
        message: "A settled conversation turn cannot carry streamed text",
      });
    }

    if (turn.usage != null && turn.status !== "succeeded") {
      context.addIssue({
        code: "custom",
        message: "Only a succeeded conversation turn can carry final usage",
      });
    }

    if (turn.status === "succeeded") {
      if (!turn.output || turn.error || !turn.completedAt) {
        context.addIssue({
          code: "custom",
          message:
            "A succeeded conversation turn requires only output and completion",
        });
      }
      return;
    }

    if (turn.status === "failed") {
      if (turn.output || !turn.error || !turn.completedAt) {
        context.addIssue({
          code: "custom",
          message:
            "A failed conversation turn requires only error and completion",
        });
      }
      return;
    }

    if (turn.output || turn.error || turn.completedAt) {
      context.addIssue({
        code: "custom",
        message: "A nonterminal conversation turn cannot contain a result",
      });
    }
  });

export const conversationThreadDocumentSchema = z
  .object({
    _id: z.uuid(),
    schemaVersion: z.literal(CONVERSATION_THREAD_SCHEMA_VERSION),
    purpose: conversationPurposeSchema,
    channel: conversationChannelSchema,
    owner: conversationOwnerSchema,
    title: z.string().trim().min(1).max(160),
    state: conversationStateSchema,
    goals: z.array(conversationGoalSchema).max(10),
    humanTakeover: conversationHumanTakeoverSchema,
    turns: z.array(conversationTurnSchema).max(CONVERSATION_THREAD_MAX_TURNS),
    createdAt: z.date(),
    updatedAt: z.date(),
  })
  .strict()
  .superRefine((thread, context) => {
    if (
      thread.purpose === "admin_assistant" &&
      (thread.channel !== "admin" ||
        thread.owner.type !== "staff" ||
        thread.goals.length !== 0)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "An admin assistant thread must use the admin channel, staff ownership and no feedback goals",
      });
    }
    if (
      thread.purpose === "post_event_feedback" &&
      (thread.channel !== "whatsapp" ||
        thread.owner.type !== "participant" ||
        thread.goals.length === 0)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "A post-event feedback thread requires WhatsApp, participant ownership and at least one goal",
      });
    }
    if (thread.updatedAt < thread.createdAt) {
      context.addIssue({
        code: "custom",
        message: "Conversation updatedAt cannot precede createdAt",
      });
    }
    if (
      thread.state === "human_takeover" &&
      !["requested", "active"].includes(thread.humanTakeover.status)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "A human-takeover conversation requires a requested or active takeover",
      });
    }
    if (
      thread.humanTakeover.status === "active" &&
      thread.state !== "human_takeover"
    ) {
      context.addIssue({
        code: "custom",
        message: "An active takeover requires the human_takeover thread state",
      });
    }

    const goalKeys = new Set<string>();
    for (const [index, goal] of thread.goals.entries()) {
      if (goalKeys.has(goal.key) || goal.ordinal !== index + 1) {
        context.addIssue({
          code: "custom",
          message:
            "Conversation goals require unique keys and contiguous ordered ordinals",
        });
        break;
      }
      goalKeys.add(goal.key);
      if (goal.updatedAt && goal.updatedAt < thread.createdAt) {
        context.addIssue({
          code: "custom",
          message: "A conversation goal cannot update before thread creation",
        });
        break;
      }
    }

    const turnIds = new Set<string>();
    for (const [index, turn] of thread.turns.entries()) {
      if (
        turnIds.has(turn.id) ||
        turn.sequence !== index + 1 ||
        turn.createdAt < thread.createdAt ||
        turn.createdAt > thread.updatedAt ||
        (turn.completedAt && turn.completedAt > thread.updatedAt)
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Conversation turns require unique ids, contiguous order and thread-bounded timestamps",
        });
        break;
      }
      turnIds.add(turn.id);
    }
  });

export type ConversationThreadDocument = z.infer<
  typeof conversationThreadDocumentSchema
>;
export type ConversationTurn = z.infer<typeof conversationTurnSchema>;
export type ConversationTurnToolCall = z.infer<
  typeof conversationTurnToolCallSchema
>;
export type ConversationTurnUsage = z.infer<typeof conversationTurnUsageSchema>;
export type ConversationGoal = z.infer<typeof conversationGoalSchema>;
