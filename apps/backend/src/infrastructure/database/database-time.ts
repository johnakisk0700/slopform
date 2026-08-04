import type { AppTransaction } from "@join-the-six/database";
import { sql } from "drizzle-orm";

/**
 * Reads PostgreSQL's wall clock and normalizes Drizzle's raw-query result.
 *
 * Drizzle deliberately returns untyped raw values from `execute`; with the
 * node-postgres adapter a timestamptz expression is therefore a string even
 * though selected timestamp columns are decoded to `Date` instances.
 */
export async function currentDatabaseTime(
  transaction: AppTransaction,
): Promise<Date> {
  const result = await transaction.execute<{ now: unknown }>(
    sql`select clock_timestamp() as now`,
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error("PostgreSQL did not return its current time");
  }

  const value = row.now;
  const parsed =
    value instanceof Date
      ? value
      : typeof value === "string"
        ? new Date(value)
        : undefined;
  if (!parsed || Number.isNaN(parsed.getTime())) {
    throw new Error("PostgreSQL returned an invalid current time");
  }
  return parsed;
}
