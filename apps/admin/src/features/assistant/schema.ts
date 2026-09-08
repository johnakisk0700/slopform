import * as z from "zod";

import type { AssistantThreadDtoOutput } from "../../api/generated/model/assistantThreadDtoOutput";
import type { AssistantThreadListDtoOutputItemsItem } from "../../api/generated/model/assistantThreadListDtoOutputItemsItem";
import type { AssistantThreadDtoOutputTurnsItem } from "../../api/generated/model/assistantThreadDtoOutputTurnsItem";
import type { AssistantThreadDtoOutputTurnsItemErrorCode } from "../../api/generated/model/assistantThreadDtoOutputTurnsItemErrorCode";
import type { AssistantThreadDtoOutputTurnsItemModel } from "../../api/generated/model/assistantThreadDtoOutputTurnsItemModel";
import type { AssistantThreadDtoOutputTurnsItemStatus } from "../../api/generated/model/assistantThreadDtoOutputTurnsItemStatus";
import type { AssistantThreadDtoOutputTurnsItemToolCallsItem } from "../../api/generated/model/assistantThreadDtoOutputTurnsItemToolCallsItem";
import type { AssistantThreadDtoOutputTurnsItemUsage } from "../../api/generated/model/assistantThreadDtoOutputTurnsItemUsage";

export const ASSISTANT_MODEL_IDS = [
  "openai/gpt-5.6-luna",
  "openai/gpt-5.6-terra",
  "google/gemini-3.6-flash",
  "qwen/qwen3.7-max",
] as const;

export const assistantModelSchema = z.enum(ASSISTANT_MODEL_IDS);
export type AssistantModel = AssistantThreadDtoOutputTurnsItemModel;

export const ASSISTANT_EFFORTS = ["low", "medium", "high"] as const;
export const ASSISTANT_SERVICE_TIERS = ["standard", "fast"] as const;
export const DEFAULT_ASSISTANT_SERVICE_TIER = "standard" as const;
export const DEFAULT_ASSISTANT_EFFORT = "low" as const;
const assistantEffortSchema = z.enum(ASSISTANT_EFFORTS);
export type AssistantEffort = z.infer<typeof assistantEffortSchema>;
const assistantServiceTierSchema = z.enum(ASSISTANT_SERVICE_TIERS);
export type AssistantServiceTier = z.infer<typeof assistantServiceTierSchema>;

export function isAssistantEffort(value: unknown): value is AssistantEffort {
  return assistantEffortSchema.safeParse(value).success;
}

export type AssistantModelBrand = "openai" | "google" | "qwen";

interface AssistantModelOption {
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

export function isAssistantServiceTier(
  value: unknown,
): value is AssistantServiceTier {
  return assistantServiceTierSchema.safeParse(value).success;
}

/**
 * Whether the fast lane exists for this model at all.
 *
 * `service_tier` is an OpenAI request parameter with no OpenRouter equivalent,
 * so the control must be disabled rather than merely ignored — the tier doubles
 * the bill, and an operator who thinks they bought speed on a model that cannot
 * sell it has been misled by the UI, not by the provider. The backend normalises
 * the same way; this only stops the request being made.
 */
export function assistantModelSupportsServiceTier(
  model: AssistantModel,
): boolean {
  return (
    ASSISTANT_MODELS.find((option) => option.id === model)?.provider ===
    "OpenAI"
  );
}

export const ASSISTANT_MESSAGE_MAX_LENGTH = 20_000;

export type AssistantFailureCode = AssistantThreadDtoOutputTurnsItemErrorCode;

export const ASSISTANT_TURN_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
] as const;

export type AssistantTurnStatus = AssistantThreadDtoOutputTurnsItemStatus;

/** Stream payloads are untyped JSON until this parser accepts their shape. */
export const assistantToolCallSchema = z
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

export type AssistantUsage = AssistantThreadDtoOutputTurnsItemUsage;

export type AssistantToolCall = AssistantThreadDtoOutputTurnsItemToolCallsItem;
export type AssistantTurn = AssistantThreadDtoOutputTurnsItem;
export type AssistantThreadSummary = AssistantThreadListDtoOutputItemsItem;
export type AssistantThread = AssistantThreadDtoOutput;

export interface AssistantDisplayMessage {
  id: string;
  turnId: string;
  role: "user" | "assistant";
  content: string;
  model: AssistantModel;
  effort: AssistantEffort;
  serviceTier: AssistantServiceTier;
  /** Provider thinking for this turn; retained when the provider supplied it. */
  reasoning: string | null;
  toolCalls: readonly AssistantToolCall[];
  usage: AssistantUsage | null;
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
      serviceTier: turn.serviceTier,
      reasoning: null,
      toolCalls: [],
      usage: null,
      status: turn.status,
    };

    // Streamed text is shown under the same id the durable answer will take, so
    // the finished reply replaces the partial in place instead of arriving as a
    // second message. It is never treated as an answer: `partial` only exists
    // while the turn is nonterminal.
    const content = turn.assistant?.content ?? turn.partial;
    if (!content && !turn.reasoning && turn.toolCalls.length === 0)
      return [user];

    return [
      user,
      {
        id: `${turn.id}-assistant`,
        turnId: turn.id,
        role: "assistant",
        content: content ?? "",
        model: turn.model,
        effort: turn.effort,
        serviceTier: turn.serviceTier,
        reasoning: turn.reasoning,
        toolCalls: turn.toolCalls,
        usage: turn.usage,
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
