import * as z from "zod";

export const ASSISTANT_MODEL_IDS = [
  "openai/gpt-5.6-luna",
  "openai/gpt-5.6-terra",
  "google/gemini-3.6-flash",
  "qwen/qwen3.7-max",
] as const;

export const assistantModelSchema = z.enum(ASSISTANT_MODEL_IDS);
export type AssistantModel = z.infer<typeof assistantModelSchema>;

export const ASSISTANT_EFFORTS = ["low", "medium", "high"] as const;
export const DEFAULT_ASSISTANT_EFFORT = "low" as const;
export const assistantEffortSchema = z.enum(ASSISTANT_EFFORTS);
export type AssistantEffort = z.infer<typeof assistantEffortSchema>;

export function isAssistantEffort(value: unknown): value is AssistantEffort {
  return assistantEffortSchema.safeParse(value).success;
}

export type AssistantModelBrand = "openai" | "google" | "qwen";

export interface AssistantModelOption {
  id: AssistantModel;
  label: string;
  brand: AssistantModelBrand;
  provider: "OpenRouter" | "OpenAI";
  description: string;
}

/**
 * The browser selector and its Zod boundary deliberately share one registry.
 * Backend adapters keep an equivalent allow-list and contract tests catch drift.
 */
export const ASSISTANT_MODELS: readonly AssistantModelOption[] = [
  {
    id: "openai/gpt-5.6-luna",
    label: "GPT-5.6 Luna",
    brand: "openai",
    provider: "OpenAI",
    description: "Fast OpenAI reasoning for high-volume operational work",
  },
  {
    id: "openai/gpt-5.6-terra",
    label: "GPT-5.6 Terra",
    brand: "openai",
    provider: "OpenAI",
    description: "Balanced OpenAI reasoning for deeper analysis",
  },
  {
    id: "google/gemini-3.6-flash",
    label: "Gemini 3.6 Flash",
    brand: "google",
    provider: "OpenRouter",
    description: "Fast long-context reasoning through OpenRouter",
  },
  {
    id: "qwen/qwen3.7-max",
    label: "Qwen3.7 Max",
    brand: "qwen",
    provider: "OpenRouter",
    description: "Top Max tier · deepest text reasoning",
  },
];

export const DEFAULT_ASSISTANT_MODEL: AssistantModel =
  "google/gemini-3.6-flash";

export function isAssistantModel(value: unknown): value is AssistantModel {
  return assistantModelSchema.safeParse(value).success;
}

const messageContentSchema = z.string().trim().min(1).max(20_000);

const userMessageSchema = z
  .object({
    role: z.literal("user"),
    content: messageContentSchema,
  })
  .strict();

const assistantMessageSchema = z
  .object({
    role: z.literal("assistant"),
    content: messageContentSchema,
  })
  .strict();

export const assistantTurnRequestSchema = z
  .object({
    requestId: z.uuid(),
    model: assistantModelSchema.optional(),
    effort: assistantEffortSchema.optional().default(DEFAULT_ASSISTANT_EFFORT),
    content: messageContentSchema,
  })
  .strict();

export type AssistantTurnRequest = z.infer<typeof assistantTurnRequestSchema>;

export function buildAssistantTurnRequest(
  requestId: string,
  model: AssistantModel,
  effort: AssistantEffort,
  content: string,
): AssistantTurnRequest {
  return assistantTurnRequestSchema.parse({
    requestId,
    model,
    effort,
    content,
  });
}

export const assistantFailureSchema = z
  .object({
    code: z.enum([
      "provider_unavailable",
      "provider_rejected",
      "generation_failed",
    ]),
    message: z.string().min(1).max(500),
  })
  .strict();

export type AssistantFailureCode = z.infer<
  typeof assistantFailureSchema
>["code"];

export const ASSISTANT_TURN_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
] as const;

export const assistantTurnStatusSchema = z.enum(ASSISTANT_TURN_STATUSES);
export type AssistantTurnStatus = z.infer<typeof assistantTurnStatusSchema>;

const turnIdentityShape = {
  id: z.uuid(),
  requestId: z.uuid(),
  sequence: z.number().int().positive(),
  model: assistantModelSchema,
  effort: assistantEffortSchema,
  user: userMessageSchema,
  attempt: z.number().int().positive(),
  createdAt: z.iso.datetime(),
} as const;

const queuedTurnSchema = z
  .object({
    ...turnIdentityShape,
    status: z.literal("queued"),
    assistant: z.null(),
    error: z.null(),
    startedAt: z.iso.datetime().nullable(),
    completedAt: z.null(),
  })
  .strict();

const runningTurnSchema = z
  .object({
    ...turnIdentityShape,
    status: z.literal("running"),
    assistant: z.null(),
    error: z.null(),
    startedAt: z.iso.datetime().nullable(),
    completedAt: z.null(),
  })
  .strict();

const succeededTurnSchema = z
  .object({
    ...turnIdentityShape,
    status: z.literal("succeeded"),
    assistant: assistantMessageSchema,
    error: z.null(),
    startedAt: z.iso.datetime().nullable(),
    completedAt: z.iso.datetime(),
  })
  .strict();

const failedTurnSchema = z
  .object({
    ...turnIdentityShape,
    status: z.literal("failed"),
    assistant: z.null(),
    error: assistantFailureSchema,
    startedAt: z.iso.datetime().nullable(),
    completedAt: z.iso.datetime(),
  })
  .strict();

export const assistantTurnSchema = z.discriminatedUnion("status", [
  queuedTurnSchema,
  runningTurnSchema,
  succeededTurnSchema,
  failedTurnSchema,
]);

export type AssistantTurn = z.infer<typeof assistantTurnSchema>;

export const assistantThreadSummarySchema = z
  .object({
    id: z.uuid(),
    title: z.string().trim().min(1).max(160),
    lastModel: assistantModelSchema,
    lastStatus: assistantTurnStatusSchema,
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

export type AssistantThreadSummary = z.infer<
  typeof assistantThreadSummarySchema
>;

export const assistantThreadListSchema = z
  .object({
    items: z.array(assistantThreadSummarySchema).max(50),
  })
  .strict();

export const assistantThreadSchema = z
  .object({
    id: z.uuid(),
    title: z.string().trim().min(1).max(160),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    turns: z.array(assistantTurnSchema).min(1),
  })
  .strict();

export type AssistantThread = z.infer<typeof assistantThreadSchema>;

export interface AssistantDisplayMessage {
  id: string;
  turnId: string;
  role: "user" | "assistant";
  content: string;
  model: AssistantModel;
  effort: AssistantEffort;
  status: AssistantTurnStatus;
}

/** Flatten durable turns into the message sequence consumed by the copied renderer. */
export function messagesFromThread(
  thread: AssistantThread | null,
): AssistantDisplayMessage[] {
  if (!thread) return [];

  return thread.turns.flatMap((turn): AssistantDisplayMessage[] => {
    const user: AssistantDisplayMessage = {
      id: `${turn.id}-user`,
      turnId: turn.id,
      role: "user",
      content: turn.user.content,
      model: turn.model,
      effort: turn.effort,
      status: turn.status,
    };

    if (!turn.assistant) return [user];

    return [
      user,
      {
        id: `${turn.id}-assistant`,
        turnId: turn.id,
        role: "assistant",
        content: turn.assistant.content,
        model: turn.model,
        effort: turn.effort,
        status: turn.status,
      },
    ];
  });
}

/** Safe operator copy for a backend failure code; raw provider text stays hidden. */
export function assistantFailureMessage(code: AssistantFailureCode): string {
  switch (code) {
    case "provider_unavailable":
      return "This model provider is not configured. Choose another model or ask an administrator to check the AI credentials.";
    case "provider_rejected":
      return "The selected provider rejected this request. Try another model or revise the message.";
    case "generation_failed":
      return "The model did not complete a response. Retry the turn or choose another model.";
  }
}
