import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export interface AssistantTurnToolCallArtifact {
  readonly toolCallId: string;
  readonly tool: string;
  readonly label: string;
  readonly state: "running" | "done" | "failed";
  readonly input: unknown | null;
  readonly output: unknown | null;
  readonly inputTruncated: boolean;
  readonly outputTruncated: boolean;
}

export const assistantThreads = pgTable(
  "assistant_threads",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    createdBy: text("created_by").notNull(),
    title: text("title").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    check(
      "assistant_threads_created_by_length_check",
      sql`char_length(btrim(${table.createdBy})) between 1 and 200`,
    ),
    check(
      "assistant_threads_title_length_check",
      sql`char_length(btrim(${table.title})) between 1 and 160`,
    ),
    index("assistant_threads_owner_updated_idx").on(
      table.createdBy,
      table.updatedAt,
    ),
    uniqueIndex("assistant_threads_id_owner_uidx").on(
      table.id,
      table.createdBy,
    ),
  ],
);

export const assistantTurns = pgTable(
  "assistant_turns",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    threadId: uuid("thread_id").notNull(),
    createdBy: text("created_by").notNull(),
    requestId: uuid("request_id").notNull(),
    /**
     * Immutable branch lineage for the first newly generated turn in a copied
     * conversation. The referenced turn is a MongoDB aggregate member rather
     * than necessarily a PostgreSQL row in this thread (a branch may itself be
     * branched), so only the source thread has a relational foreign key.
     */
    branchedFromThreadId: uuid("branched_from_thread_id"),
    branchedFromTurnId: uuid("branched_from_turn_id"),
    sequence: integer("sequence").notNull(),
    status: text("status").notNull().default("queued"),
    model: text("model").notNull(),
    effort: text("effort").notNull().default("low"),
    /**
     * The OpenAI service tier this turn actually ran under. `fast` doubles the
     * token price, so it is persisted next to model and effort rather than read
     * back from a browser preference — a turn that cannot be repriced from its
     * own row is not auditable. Turns routed through OpenRouter are always
     * `standard`: the parameter does not exist there.
     */
    serviceTier: text("service_tier").notNull().default("standard"),
    attempt: integer("attempt").notNull().default(1),
    userContent: text("user_content").notNull(),
    assistantContent: text("assistant_content"),
    /**
     * Text streamed so far by the in-flight attempt. Deliberately separate from
     * `assistant_content`: the result check below is what makes "succeeded
     * content is authoritative" true, so partial text must never be able to
     * occupy that column. Cleared when the turn reaches a terminal state.
     */
    streamedContent: text("streamed_content"),
    /** The provider's thinking summary/deltas, retained with the settled turn. */
    reasoningContent: text("reasoning_content"),
    /** Bounded, operator-visible tool traces for this exact attempt. */
    toolCalls: jsonb("tool_calls")
      .$type<AssistantTurnToolCallArtifact[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    reasoningTokens: integer("reasoning_tokens"),
    cachedInputTokens: integer("cached_input_tokens"),
    totalTokens: integer("total_tokens"),
    /** An estimate, never provider billing authority. One euro = 1,000,000. */
    estimatedCostEurMicros: integer("estimated_cost_eur_micros"),
    pricingVersion: text("pricing_version"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }),
    completedAt: timestamp("completed_at", {
      withTimezone: true,
      mode: "date",
    }),
  },
  (table) => [
    foreignKey({
      columns: [table.threadId, table.createdBy],
      foreignColumns: [assistantThreads.id, assistantThreads.createdBy],
      name: "assistant_turns_thread_owner_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.branchedFromThreadId],
      foreignColumns: [assistantThreads.id],
      name: "assistant_turns_branch_source_thread_fk",
    }).onDelete("restrict"),
    check(
      "assistant_turns_created_by_length_check",
      sql`char_length(btrim(${table.createdBy})) between 1 and 200`,
    ),
    check("assistant_turns_sequence_check", sql`${table.sequence} >= 1`),
    check("assistant_turns_attempt_check", sql`${table.attempt} >= 1`),
    check(
      "assistant_turns_branch_origin_check",
      sql`(${table.branchedFromThreadId} is null) = (${table.branchedFromTurnId} is null)`,
    ),
    check(
      "assistant_turns_status_check",
      sql`${table.status} in ('queued', 'running', 'succeeded', 'failed')`,
    ),
    check(
      "assistant_turns_model_check",
      sql`${table.model} in ('openai/gpt-5.6-luna', 'openai/gpt-5.6-terra', 'google/gemini-3.6-flash', 'qwen/qwen3.7-max')`,
    ),
    check(
      "assistant_turns_effort_check",
      sql`${table.effort} in ('low', 'medium', 'high')`,
    ),
    check(
      "assistant_turns_user_content_length_check",
      sql`char_length(btrim(${table.userContent})) between 1 and 20000`,
    ),
    check(
      "assistant_turns_error_fields_check",
      sql`(${table.status} = 'failed' and ${table.errorCode} is not null and ${table.errorMessage} is not null) or (${table.status} <> 'failed' and ${table.errorCode} is null and ${table.errorMessage} is null)`,
    ),
    check(
      "assistant_turns_error_code_check",
      sql`${table.errorCode} is null or ${table.errorCode} in ('provider_unavailable', 'provider_rejected', 'generation_failed')`,
    ),
    check(
      "assistant_turns_result_check",
      sql`(${table.status} = 'succeeded' and ${table.assistantContent} is not null and char_length(btrim(${table.assistantContent})) >= 1 and ${table.completedAt} is not null) or (${table.status} <> 'succeeded' and ${table.assistantContent} is null)`,
    ),
    check(
      "assistant_turns_service_tier_check",
      sql`${table.serviceTier} in ('standard', 'fast')`,
    ),
    check(
      "assistant_turns_streamed_content_check",
      sql`${table.streamedContent} is null or ${table.status} in ('queued', 'running')`,
    ),
    check(
      "assistant_turns_tool_calls_check",
      sql`jsonb_typeof(${table.toolCalls}) = 'array' and jsonb_array_length(${table.toolCalls}) <= 20`,
    ),
    check(
      "assistant_turns_usage_nonnegative_check",
      sql`(${table.inputTokens} is null or ${table.inputTokens} >= 0) and (${table.outputTokens} is null or ${table.outputTokens} >= 0) and (${table.reasoningTokens} is null or ${table.reasoningTokens} >= 0) and (${table.cachedInputTokens} is null or ${table.cachedInputTokens} >= 0) and (${table.totalTokens} is null or ${table.totalTokens} >= 0) and (${table.estimatedCostEurMicros} is null or ${table.estimatedCostEurMicros} >= 0)`,
    ),
    check(
      "assistant_turns_usage_status_check",
      sql`(${table.inputTokens} is null and ${table.outputTokens} is null and ${table.reasoningTokens} is null and ${table.cachedInputTokens} is null and ${table.totalTokens} is null and ${table.estimatedCostEurMicros} is null and ${table.pricingVersion} is null) or ${table.status} = 'succeeded'`,
    ),
    check(
      "assistant_turns_pricing_version_check",
      sql`(${table.estimatedCostEurMicros} is null and ${table.pricingVersion} is null) or (${table.estimatedCostEurMicros} is not null and char_length(btrim(${table.pricingVersion})) between 1 and 32)`,
    ),
    check(
      "assistant_turns_completion_check",
      sql`(${table.status} in ('succeeded', 'failed') and ${table.completedAt} is not null) or (${table.status} in ('queued', 'running') and ${table.completedAt} is null)`,
    ),
    uniqueIndex("assistant_turns_thread_sequence_uidx").on(
      table.threadId,
      table.sequence,
    ),
    uniqueIndex("assistant_turns_owner_request_id_uidx").on(
      table.createdBy,
      table.requestId,
    ),
    uniqueIndex("assistant_turns_one_active_per_thread_uidx")
      .on(table.threadId)
      .where(sql`${table.status} in ('queued', 'running')`),
    index("assistant_turns_status_created_idx").on(
      table.status,
      table.createdAt,
    ),
    index("assistant_turns_thread_created_idx").on(
      table.threadId,
      table.createdAt,
    ),
    // Partial on purpose: almost every turn is a root turn with null lineage,
    // and the index only ever answers "who branched from here".
    index("assistant_turns_branch_source_idx")
      .on(table.branchedFromThreadId, table.branchedFromTurnId)
      .where(sql`${table.branchedFromThreadId} is not null`),
  ],
);

export type AssistantThreadRow = typeof assistantThreads.$inferSelect;
export type AssistantTurnRow = typeof assistantTurns.$inferSelect;
