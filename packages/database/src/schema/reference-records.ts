import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Disposable scaffold table used by the backend golden module.
 * Replace this module and its migration before product-domain work starts.
 */
export const referenceRecords = pgTable("reference_records", {
  id: uuid("id").defaultRandom().primaryKey(),
  label: text("label").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
    .defaultNow()
    .notNull(),
});

export type ReferenceRecordInsert = typeof referenceRecords.$inferInsert;
export type ReferenceRecordRow = typeof referenceRecords.$inferSelect;
