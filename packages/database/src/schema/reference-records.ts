import { sql } from "drizzle-orm";
import { check, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Disposable scaffold table used by the backend golden module.
 * Replace this module and its migration before product-domain work starts.
 */
export const referenceRecords = pgTable(
  "reference_records",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    label: text("label").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    check(
      "reference_records_label_length_check",
      sql`char_length(btrim(${table.label})) between 1 and 120`,
    ),
  ],
);

export type ReferenceRecordRow = typeof referenceRecords.$inferSelect;
