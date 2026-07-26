import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Dev-only durable sink for `TRANSPORT_MODE=simulated` outbound sends (WP8).
 * No foreign keys: this is throwaway local/staging traffic, not business audit.
 */
export const feedbackSimOutbound = pgTable(
  "feedback_sim_outbound",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    outboxId: uuid("outbox_id").notNull(),
    phoneE164: text("phone_e164").notNull(),
    body: text("body").notNull(),
    providerMessageId: text("provider_message_id").notNull(),
    sentAt: timestamp("sent_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    check(
      "feedback_sim_outbound_body_length_check",
      sql`char_length(btrim(${table.body})) between 1 and 4096`,
    ),
    check(
      "feedback_sim_outbound_phone_e164_length_check",
      sql`char_length(btrim(${table.phoneE164})) between 8 and 20`,
    ),
    uniqueIndex("feedback_sim_outbound_provider_message_id_uidx").on(
      table.providerMessageId,
    ),
    index("feedback_sim_outbound_phone_sent_idx").on(
      table.phoneE164,
      table.sentAt,
    ),
  ],
);

export type FeedbackSimOutboundRow = typeof feedbackSimOutbound.$inferSelect;
