import {
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
export type AuditEventRow = typeof auditEvents.$inferSelect;
