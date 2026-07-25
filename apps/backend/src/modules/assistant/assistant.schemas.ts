import { createZodDto } from "nestjs-zod";
import { z } from "zod";

export const ASSISTANT_MODELS = [
  "openai/gpt-5.6-luna",
  "openai/gpt-5.6-terra",
  "google/gemini-3.6-flash",
  "qwen/qwen3.7-max",
] as const;
export const DEFAULT_ASSISTANT_MODEL = "google/gemini-3.6-flash" as const;
export const ASSISTANT_REASONING_EFFORTS = ["low", "medium", "high"] as const;
export const DEFAULT_ASSISTANT_REASONING_EFFORT = "low" as const;
export const ASSISTANT_EFFORTS = ASSISTANT_REASONING_EFFORTS;
export const DEFAULT_ASSISTANT_EFFORT = DEFAULT_ASSISTANT_REASONING_EFFORT;

export const ASSISTANT_TURN_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
] as const;
export const ASSISTANT_FAILURE_CODES = [
  "provider_unavailable",
  "provider_rejected",
  "generation_failed",
] as const;

export const ASSISTANT_JOB_NAMES = {
  generateTurnV2: "assistant.generate-turn.v2",
} as const;
export const ASSISTANT_JOB_SCHEMA_VERSION = 2;

export const assistantModelSchema = z.enum(ASSISTANT_MODELS);
export const assistantTurnStatusSchema = z.enum(ASSISTANT_TURN_STATUSES);
export const assistantFailureCodeSchema = z.enum(ASSISTANT_FAILURE_CODES);
export const assistantReasoningEffortSchema = z.enum(
  ASSISTANT_REASONING_EFFORTS,
);
export const assistantContentSchema = z.string().trim().min(1).max(20_000);

export const createAssistantTurnSchema = z
  .object({
    requestId: z.uuid(),
    model: assistantModelSchema.optional(),
    effort: assistantReasoningEffortSchema
      .optional()
      .default(DEFAULT_ASSISTANT_REASONING_EFFORT),
    content: assistantContentSchema,
  })
  .strict();
export const createAssistantThreadSchema = createAssistantTurnSchema;

export const assistantThreadIdSchema = z.object({ id: z.uuid() }).strict();
export const assistantTurnParametersSchema = z
  .object({ threadId: z.uuid(), turnId: z.uuid() })
  .strict();
export const assistantPrincipalSchema = z.string().min(1).max(200);
export const assistantCorrelationIdSchema = z.string().min(1).max(128);

export const assistantTurnErrorSchema = z
  .object({
    code: assistantFailureCodeSchema,
    message: z.string().min(1).max(500),
  })
  .strict();

export const assistantUserMessageSchema = z
  .object({ role: z.literal("user"), content: assistantContentSchema })
  .strict();
export const assistantResponseMessageSchema = z
  .object({ role: z.literal("assistant"), content: assistantContentSchema })
  .strict();

export const assistantTurnSchema = z
  .object({
    id: z.uuid(),
    requestId: z.uuid(),
    sequence: z.number().int().positive(),
    status: assistantTurnStatusSchema,
    model: assistantModelSchema,
    effort: assistantReasoningEffortSchema,
    user: assistantUserMessageSchema,
    assistant: assistantResponseMessageSchema.nullable(),
    error: assistantTurnErrorSchema.nullable(),
    attempt: z.number().int().positive(),
    createdAt: z.iso.datetime(),
    startedAt: z.iso.datetime().nullable(),
    completedAt: z.iso.datetime().nullable(),
  })
  .strict()
  .superRefine((turn, context) => {
    const hasAssistant = turn.assistant !== null;
    const hasError = turn.error !== null;
    const isComplete = turn.completedAt !== null;

    if (turn.status === "succeeded") {
      if (!hasAssistant || hasError || !isComplete) {
        context.addIssue({
          code: "custom",
          message:
            "A succeeded turn requires only an assistant response and completion",
        });
      }
      return;
    }

    if (turn.status === "failed") {
      if (hasAssistant || !hasError || !isComplete) {
        context.addIssue({
          code: "custom",
          message: "A failed turn requires only an error and completion",
        });
      }
      return;
    }

    if (hasAssistant || hasError || isComplete) {
      context.addIssue({
        code: "custom",
        message: "A nonterminal turn cannot contain a result or completion",
      });
    }
  });

export const assistantThreadSchema = z
  .object({
    id: z.uuid(),
    title: z.string().trim().min(1).max(160),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    turns: z.array(assistantTurnSchema).min(1),
  })
  .strict();

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
export const assistantThreadListSchema = z
  .object({ items: z.array(assistantThreadSummarySchema).max(50) })
  .strict();

export const assistantJobDataSchema = z
  .object({
    schemaVersion: z.literal(ASSISTANT_JOB_SCHEMA_VERSION),
    turnId: z.uuid(),
    correlationId: z.string().min(1).max(128),
  })
  .strict();

export class CreateAssistantThreadDto extends createZodDto(
  createAssistantThreadSchema,
) {}
export class CreateAssistantTurnDto extends createZodDto(
  createAssistantTurnSchema,
) {}
export class AssistantThreadIdDto extends createZodDto(
  assistantThreadIdSchema,
) {}
export class AssistantTurnParametersDto extends createZodDto(
  assistantTurnParametersSchema,
) {}
const AssistantPrincipalDtoBase = createZodDto(
  assistantPrincipalSchema,
) as unknown as new () => object;
const AssistantCorrelationIdDtoBase = createZodDto(
  assistantCorrelationIdSchema,
) as unknown as new () => object;
export class AssistantPrincipalDto extends AssistantPrincipalDtoBase {}
export class AssistantCorrelationIdDto extends AssistantCorrelationIdDtoBase {}
export class AssistantTurnDto extends createZodDto(assistantTurnSchema) {}
export class AssistantThreadDto extends createZodDto(assistantThreadSchema) {}
export class AssistantThreadListDto extends createZodDto(
  assistantThreadListSchema,
) {}

export type AssistantModel = z.infer<typeof assistantModelSchema>;
export type CreateAssistantTurnInput = z.input<
  typeof createAssistantTurnSchema
>;
export type CreateAssistantThreadInput = z.input<
  typeof createAssistantThreadSchema
>;
export type AssistantTurnStatus = z.infer<typeof assistantTurnStatusSchema>;
export type AssistantFailureCode = z.infer<typeof assistantFailureCodeSchema>;
export type AssistantReasoningEffort = z.infer<
  typeof assistantReasoningEffortSchema
>;
export type AssistantTurnView = z.infer<typeof assistantTurnSchema>;
export type AssistantThreadView = z.infer<typeof assistantThreadSchema>;
export type AssistantThreadListView = z.infer<typeof assistantThreadListSchema>;
export type AssistantJobData = z.infer<typeof assistantJobDataSchema>;
export type AssistantJobName =
  (typeof ASSISTANT_JOB_NAMES)[keyof typeof ASSISTANT_JOB_NAMES];

export function createAssistantTurnJobId(
  turnId: string,
  attempt: number,
): string {
  return `assistant-generate-v2-${turnId}-${attempt}`;
}

export function parseAssistantTurnJobAttempt(
  jobId: string | undefined,
  turnId: string,
): number | undefined {
  const prefix = `assistant-generate-v2-${turnId}-`;
  if (!jobId?.startsWith(prefix)) {
    return undefined;
  }

  const value = Number(jobId.slice(prefix.length));
  return Number.isSafeInteger(value) && value >= 1 ? value : undefined;
}
