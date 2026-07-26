import { sql } from "drizzle-orm";
import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id"),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    requestId: text("request_id"),
    context: jsonb("context")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
  },
  (table) => [
    check(
      "audit_events_actor_type_length_check",
      sql`char_length(btrim(${table.actorType})) between 1 and 64`,
    ),
    check(
      "audit_events_actor_id_length_check",
      sql`char_length(btrim(${table.actorId})) between 1 and 200`,
    ),
    check(
      "audit_events_action_length_check",
      sql`char_length(btrim(${table.action})) between 1 and 120`,
    ),
    check(
      "audit_events_entity_type_length_check",
      sql`char_length(btrim(${table.entityType})) between 1 and 64`,
    ),
    check(
      "audit_events_entity_id_length_check",
      sql`char_length(btrim(${table.entityId})) between 1 and 200`,
    ),
    check(
      "audit_events_request_id_length_check",
      sql`char_length(btrim(${table.requestId})) between 1 and 128`,
    ),
    check(
      "audit_events_context_object_check",
      sql`jsonb_typeof(${table.context}) = 'object'`,
    ),
    index("audit_events_entity_idx").on(
      table.entityType,
      table.entityId,
      table.occurredAt,
    ),
    index("audit_events_actor_idx").on(
      table.actorType,
      table.actorId,
      table.occurredAt,
    ),
  ],
);

export type AuditEventInsert = typeof auditEvents.$inferInsert;
