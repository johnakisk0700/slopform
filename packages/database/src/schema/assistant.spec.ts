import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { assistantTurns } from "./assistant.js";

const dialect = new PgDialect();

describe("assistant turn database constraints", () => {
  it("requires a non-null successful result and allowlists failure codes", () => {
    const config = getTableConfig(assistantTurns);
    const checks = new Map(
      config.checks.map((check) => [
        check.name,
        dialect.sqlToQuery(check.value).sql,
      ]),
    );

    expect(checks.get("assistant_turns_result_check")).toContain(
      '"assistant_turns"."assistant_content" is not null',
    );
    expect(checks.get("assistant_turns_error_code_check")).toContain(
      "'provider_unavailable', 'provider_rejected', 'generation_failed'",
    );
    expect(checks.get("assistant_turns_effort_check")).toContain(
      "'low', 'medium', 'high'",
    );
    expect(checks.get("assistant_turns_model_check")).toContain(
      "'qwen/qwen3.7-max'",
    );
  });

  it("keeps idempotency owner-scoped and one active turn per thread", () => {
    const config = getTableConfig(assistantTurns);
    const indexes = new Map(
      config.indexes.map((index) => [index.config.name, index]),
    );
    const requestIndex = indexes.get("assistant_turns_owner_request_id_uidx");
    const activeIndex = indexes.get(
      "assistant_turns_one_active_per_thread_uidx",
    );

    expect(requestIndex?.config.unique).toBe(true);
    expect(
      requestIndex?.config.columns.map((column) =>
        "name" in column ? column.name : undefined,
      ),
    ).toEqual(["created_by", "request_id"]);
    expect(activeIndex?.config.unique).toBe(true);
    expect(
      activeIndex?.config.where
        ? dialect.sqlToQuery(activeIndex.config.where).sql
        : undefined,
    ).toContain("in ('queued', 'running')");
  });

  it("fails closed on legacy run data before any durable-table mutation", () => {
    const migration = readFileSync(
      new URL(
        "../../drizzle/20260723015214_durable_assistant_threads.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const guard = migration.indexOf(
      'IF EXISTS (SELECT 1 FROM "assistant_runs"',
    );
    const create = migration.indexOf('CREATE TABLE "assistant_threads"');
    const drop = migration.indexOf('DROP TABLE "assistant_runs"');

    expect(guard).toBeGreaterThanOrEqual(0);
    expect(guard).toBeLessThan(create);
    expect(guard).toBeLessThan(drop);
  });

  it("widens the applied model constraint without replaying unrelated schema", () => {
    const migration = readFileSync(
      new URL(
        "../../drizzle/20260723025013_allow_qwen_3_7_max_assistant_turns.sql",
        import.meta.url,
      ),
      "utf8",
    );

    expect(migration).toContain(
      'DROP CONSTRAINT "assistant_turns_model_check"',
    );
    expect(migration).toContain("'qwen/qwen3.7-max'");
    expect(migration).not.toContain('ADD COLUMN "effort"');
    expect(migration).not.toContain(
      'DROP CONSTRAINT "assistant_turns_result_check"',
    );
    expect(migration.match(/ALTER TABLE/g)).toHaveLength(2);
  });
});
import { readFileSync } from "node:fs";
