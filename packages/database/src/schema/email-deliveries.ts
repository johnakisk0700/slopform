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

export const emailDeliveries = pgTable(
  "email_deliveries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    createdBy: text("created_by").notNull(),
    requestId: uuid("request_id").notNull(),
    requestFingerprint: text("request_fingerprint").notNull(),
    recipientEmail: text("recipient_email").notNull(),
    subject: text("subject").notNull(),
    textBody: text("text_body").notNull(),
    status: text("status").notNull().default("queued"),
    attemptCount: integer("attempt_count").notNull().default(0),
    leaseToken: uuid("lease_token"),
    leaseUntil: timestamp("lease_until", {
      withTimezone: true,
      mode: "date",
    }),
    nextAttemptAt: timestamp("next_attempt_at", {
      withTimezone: true,
      mode: "date",
    }),
    lastErrorCode: text("last_error_code"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
    completedAt: timestamp("completed_at", {
      withTimezone: true,
      mode: "date",
    }),
  },
  (table) => [
    check(
      "email_deliveries_created_by_length_check",
      sql`char_length(btrim(${table.createdBy})) between 1 and 200`,
    ),
    check(
      "email_deliveries_fingerprint_check",
      sql`${table.requestFingerprint} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "email_deliveries_recipient_length_check",
      sql`char_length(${table.recipientEmail}) between 3 and 320`,
    ),
    check(
      "email_deliveries_subject_length_check",
      sql`char_length(btrim(${table.subject})) between 1 and 200`,
    ),
    check(
      "email_deliveries_body_length_check",
      sql`char_length(btrim(${table.textBody})) between 1 and 100000`,
    ),
    check(
      "email_deliveries_status_check",
      sql`${table.status} in ('queued', 'processing', 'retry_scheduled', 'blocked', 'sent', 'failed')`,
    ),
    check(
      "email_deliveries_attempt_count_check",
      sql`${table.attemptCount} >= 0`,
    ),
    check(
      "email_deliveries_lease_check",
      sql`(${table.status} = 'processing' and ${table.leaseToken} is not null and ${table.leaseUntil} is not null) or (${table.status} <> 'processing' and ${table.leaseToken} is null and ${table.leaseUntil} is null)`,
    ),
    check(
      "email_deliveries_next_attempt_check",
      sql`(${table.status} = 'retry_scheduled' and ${table.nextAttemptAt} is not null) or (${table.status} <> 'retry_scheduled' and ${table.nextAttemptAt} is null)`,
    ),
    check(
      "email_deliveries_error_check",
      sql`(${table.status} in ('retry_scheduled', 'blocked', 'failed') and ${table.lastErrorCode} is not null) or (${table.status} in ('queued', 'processing', 'sent') and ${table.lastErrorCode} is null)`,
    ),
    check(
      "email_deliveries_completion_check",
      sql`(${table.status} in ('blocked', 'sent', 'failed') and ${table.completedAt} is not null) or (${table.status} in ('queued', 'processing', 'retry_scheduled') and ${table.completedAt} is null)`,
    ),
    uniqueIndex("email_deliveries_owner_request_uidx").on(
      table.createdBy,
      table.requestId,
    ),
    index("email_deliveries_owner_created_idx").on(
      table.createdBy,
      table.createdAt,
    ),
    index("email_deliveries_due_idx").on(
      table.status,
      table.nextAttemptAt,
      table.createdAt,
    ),
    index("email_deliveries_lease_idx").on(table.status, table.leaseUntil),
  ],
);

export const emailDeliveryAttempts = pgTable(
  "email_delivery_attempts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    deliveryId: uuid("delivery_id").notNull(),
    attemptNumber: integer("attempt_number").notNull(),
    status: text("status").notNull().default("processing"),
    errorCode: text("error_code"),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
    completedAt: timestamp("completed_at", {
      withTimezone: true,
      mode: "date",
    }),
  },
  (table) => [
    foreignKey({
      columns: [table.deliveryId],
      foreignColumns: [emailDeliveries.id],
      name: "email_delivery_attempts_delivery_fk",
    }).onDelete("restrict"),
    check(
      "email_delivery_attempts_number_check",
      sql`${table.attemptNumber} >= 1`,
    ),
    check(
      "email_delivery_attempts_status_check",
      sql`${table.status} in ('processing', 'retry_scheduled', 'blocked', 'sent', 'failed', 'unknown')`,
    ),
    check(
      "email_delivery_attempts_completion_check",
      sql`(${table.status} = 'processing' and ${table.completedAt} is null) or (${table.status} <> 'processing' and ${table.completedAt} is not null)`,
    ),
    check(
      "email_delivery_attempts_error_check",
      sql`(${table.status} in ('retry_scheduled', 'blocked', 'failed', 'unknown') and ${table.errorCode} is not null) or (${table.status} in ('processing', 'sent') and ${table.errorCode} is null)`,
    ),
    uniqueIndex("email_delivery_attempts_delivery_number_uidx").on(
      table.deliveryId,
      table.attemptNumber,
    ),
    index("email_delivery_attempts_delivery_started_idx").on(
      table.deliveryId,
      table.startedAt,
    ),
  ],
);

export const emailOutboxEvents = pgTable(
  "email_outbox_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    deliveryId: uuid("delivery_id").notNull(),
    eventType: text("event_type")
      .notNull()
      .default("email.delivery.requested.v1"),
    correlationId: text("correlation_id").notNull(),
    status: text("status").notNull().default("pending"),
    publishAttempts: integer("publish_attempts").notNull().default(0),
    availableAt: timestamp("available_at", {
      withTimezone: true,
      mode: "date",
    })
      .defaultNow()
      .notNull(),
    leaseToken: uuid("lease_token"),
    leaseUntil: timestamp("lease_until", {
      withTimezone: true,
      mode: "date",
    }),
    lastErrorCode: text("last_error_code"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
    dispatchedAt: timestamp("dispatched_at", {
      withTimezone: true,
      mode: "date",
    }),
    consumedAt: timestamp("consumed_at", {
      withTimezone: true,
      mode: "date",
    }),
  },
  (table) => [
    foreignKey({
      columns: [table.deliveryId],
      foreignColumns: [emailDeliveries.id],
      name: "email_outbox_events_delivery_fk",
    }).onDelete("restrict"),
    check(
      "email_outbox_events_type_check",
      sql`${table.eventType} = 'email.delivery.requested.v1'`,
    ),
    check(
      "email_outbox_events_correlation_length_check",
      sql`char_length(btrim(${table.correlationId})) between 1 and 128`,
    ),
    check(
      "email_outbox_events_status_check",
      sql`${table.status} in ('pending', 'publishing', 'dispatched', 'consumed')`,
    ),
    check(
      "email_outbox_events_attempts_check",
      sql`${table.publishAttempts} >= 0`,
    ),
    check(
      "email_outbox_events_lease_check",
      sql`(${table.status} = 'publishing' and ${table.leaseToken} is not null and ${table.leaseUntil} is not null) or (${table.status} <> 'publishing' and ${table.leaseToken} is null and ${table.leaseUntil} is null)`,
    ),
    check(
      "email_outbox_events_published_check",
      sql`(${table.status} in ('dispatched', 'consumed') and ${table.dispatchedAt} is not null) or (${table.status} in ('pending', 'publishing') and ${table.dispatchedAt} is null)`,
    ),
    check(
      "email_outbox_events_consumed_check",
      sql`(${table.status} = 'consumed' and ${table.consumedAt} is not null) or (${table.status} <> 'consumed' and ${table.consumedAt} is null)`,
    ),
    index("email_outbox_events_claim_idx").on(
      table.status,
      table.availableAt,
      table.createdAt,
    ),
    index("email_outbox_events_lease_idx").on(table.status, table.leaseUntil),
  ],
);

export type EmailDeliveryRow = typeof emailDeliveries.$inferSelect;
export type EmailDeliveryAttemptRow = typeof emailDeliveryAttempts.$inferSelect;
export type EmailOutboxEventRow = typeof emailOutboxEvents.$inferSelect;
