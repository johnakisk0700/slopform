import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  doublePrecision,
} from "drizzle-orm/pg-core";
import { feedbackCampaigns } from "./post-event-feedback.js";

/** Immutable input/config/result; mutable execution state is fenced separately. */
export const feedbackTopicAnalyses = pgTable(
  "feedback_topic_analyses",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => feedbackCampaigns.id, { onDelete: "restrict" }),
    identityHash: text("identity_hash").notNull(),
    snapshotHash: text("snapshot_hash").notNull(),
    snapshot: jsonb("snapshot").$type<unknown>().notNull(),
    configuration: jsonb("configuration").$type<unknown>().notNull(),
    requestedBy: text("requested_by").notNull(),
    status: text("status").notNull().default("pending"),
    stage: text("stage").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    executionEpoch: integer("execution_epoch").notNull().default(0),
    claimToken: uuid("claim_token"),
    claimExpiresAt: timestamp("claim_expires_at", {
      withTimezone: true,
      mode: "date",
    }),
    nextWakeupAt: timestamp("next_wakeup_at", {
      withTimezone: true,
      mode: "date",
    })
      .defaultNow()
      .notNull(),
    reservedRequests: integer("reserved_requests").notNull().default(0),
    reservedInputBytes: integer("reserved_input_bytes").notNull().default(0),
    observedPromptTokens: integer("observed_prompt_tokens")
      .notNull()
      .default(0),
    observedResponses: integer("observed_responses").notNull().default(0),
    observedCostUsd: doublePrecision("observed_cost_usd"),
    result: jsonb("result").$type<unknown>(),
    errorCode: text("error_code"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
    completedAt: timestamp("completed_at", {
      withTimezone: true,
      mode: "date",
    }),
  },
  (table) => [
    uniqueIndex("feedback_topic_analyses_identity_uidx").on(
      table.campaignId,
      table.identityHash,
    ),
    index("feedback_topic_analyses_due_idx")
      .on(table.nextWakeupAt, table.id)
      .where(sql`${table.status} in ('pending', 'running')`),
    check(
      "feedback_topic_analyses_status_check",
      sql`${table.status} in ('pending', 'running', 'completed', 'failed')`,
    ),
    check(
      "feedback_topic_analyses_terminal_check",
      sql`(${table.status} = 'completed' and ${table.result} is not null and ${table.completedAt} is not null) or (${table.status} <> 'completed' and ${table.result} is null)`,
    ),
    check(
      "feedback_topic_analyses_budget_check",
      sql`${table.attempts} between 0 and 3 and ${table.reservedRequests} between 0 and 48 and ${table.reservedInputBytes} between 0 and 786432 and ${table.observedPromptTokens} >= 0 and ${table.observedResponses} between 0 and 48`,
    ),
    check(
      "feedback_topic_analyses_snapshot_check",
      sql`jsonb_typeof(${table.snapshot}) = 'object' and octet_length(${table.snapshot}::text) <= 2097152`,
    ),
    check(
      "feedback_topic_analyses_config_check",
      sql`jsonb_typeof(${table.configuration}) = 'object' and octet_length(${table.configuration}::text) <= 8192`,
    ),
    check(
      "feedback_topic_analyses_result_check",
      sql`${table.result} is null or (jsonb_typeof(${table.result}) = 'object' and octet_length(${table.result}::text) <= 2097152)`,
    ),
    check(
      "feedback_topic_analyses_claim_check",
      sql`(${table.claimToken} is null) = (${table.claimExpiresAt} is null)`,
    ),
  ],
);

/** One deployment-wide lease bounds all topic providers and subprocesses. */
export const feedbackTopicAnalysisSlot = pgTable(
  "feedback_topic_analysis_slot",
  {
    id: integer("id").primaryKey(),
    claimToken: uuid("claim_token"),
    claimExpiresAt: timestamp("claim_expires_at", {
      withTimezone: true,
      mode: "date",
    }),
  },
  (table) => [
    check("feedback_topic_analysis_slot_singleton_check", sql`${table.id} = 1`),
    check(
      "feedback_topic_analysis_slot_claim_check",
      sql`(${table.claimToken} is null) = (${table.claimExpiresAt} is null)`,
    ),
  ],
);

/** Batch clustering reads by exact key; similarity indexes are not required. */
export const feedbackTopicEmbeddings = pgTable(
  "feedback_topic_embeddings",
  {
    cacheKey: text("cache_key").primaryKey(),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => feedbackCampaigns.id, { onDelete: "restrict" }),
    configurationHash: text("configuration_hash").notNull(),
    inputHash: text("input_hash").notNull(),
    embedding: real("embedding").array().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    check(
      "feedback_topic_embeddings_dimensions_check",
      sql`array_ndims(${table.embedding}) = 1 and cardinality(${table.embedding}) = 1024 and array_position(${table.embedding}, null) is null and not (${table.embedding} && array['NaN'::real, 'Infinity'::real, '-Infinity'::real])`,
    ),
    index("feedback_topic_embeddings_campaign_idx").on(table.campaignId),
  ],
);

export type FeedbackTopicAnalysisRow =
  typeof feedbackTopicAnalyses.$inferSelect;
export type FeedbackTopicAnalysisInsert =
  typeof feedbackTopicAnalyses.$inferInsert;
export type FeedbackTopicEmbeddingInsert =
  typeof feedbackTopicEmbeddings.$inferInsert;
