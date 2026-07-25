import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

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
    sequence: integer("sequence").notNull(),
    status: text("status").notNull().default("queued"),
    model: text("model").notNull(),
    effort: text("effort").notNull().default("low"),
    attempt: integer("attempt").notNull().default(1),
    userContent: text("user_content").notNull(),
    assistantContent: text("assistant_content"),
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
    check(
      "assistant_turns_created_by_length_check",
      sql`char_length(btrim(${table.createdBy})) between 1 and 200`,
    ),
    check("assistant_turns_sequence_check", sql`${table.sequence} >= 1`),
    check("assistant_turns_attempt_check", sql`${table.attempt} >= 1`),
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
  ],
);

export type AssistantThreadInsert = typeof assistantThreads.$inferInsert;
export type AssistantThreadRow = typeof assistantThreads.$inferSelect;
export type AssistantTurnInsert = typeof assistantTurns.$inferInsert;
export type AssistantTurnRow = typeof assistantTurns.$inferSelect;
