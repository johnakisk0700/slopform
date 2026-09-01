import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const FEEDBACK_RUNTIME_ENVIRONMENT_KEYS = [
  "FEEDBACK_ATTENTION_REASONING_EFFORT",
  "FEEDBACK_EXPIRE_AFTER_HOURS",
  "FEEDBACK_EXTRACTION_MODEL",
  "FEEDBACK_EXTRACTION_REASONING_EFFORT",
  "FEEDBACK_EXTRACTION_SERVICE_TIER",
  "FEEDBACK_EXTRACTION_STUB",
  "FEEDBACK_INGRESS_PENDING_RECOVERY_MINUTES",
  "FEEDBACK_MAX_REMINDERS",
  "FEEDBACK_OPERATOR_ALERT_MODE",
  "FEEDBACK_PRODUCTION_REHEARSAL_ENABLED",
  "FEEDBACK_REPLY_REASONING_EFFORT",
  "FEEDBACK_REMINDER_AFTER_HOURS",
  "FEEDBACK_SIMULATOR_ENABLED",
  "FEEDBACK_SIMULATED_TRANSPORT_FAULT_MODE",
  "FEEDBACK_SIMULATED_TRANSPORT_FAULT_PERCENT",
  "FEEDBACK_SIMULATED_TRANSPORT_MAX_DELAY_MS",
  "FEEDBACK_SIMULATED_TRANSPORT_SEED",
  "FEEDBACK_SUMMARY_MODEL",
  "FEEDBACK_SUMMARY_REASONING_EFFORT",
] as const;

const repositoryFile = (path: string): string =>
  readFileSync(new URL(`../../../../../${path}`, import.meta.url), "utf8");

describe("feedback environment launch surfaces", () => {
  it("passes every feedback runtime setting through the persistent Turbo task", () => {
    const turbo = JSON.parse(repositoryFile("turbo.json")) as {
      tasks: Record<string, { passThroughEnv?: string[] }>;
    };
    const passed = turbo.tasks["@slopform/backend#dev"]?.passThroughEnv ?? [];

    expect(passed).toEqual(
      expect.arrayContaining([...FEEDBACK_RUNTIME_ENVIRONMENT_KEYS]),
    );
  });

  it.each([
    ".env.example",
    ".env.production.example",
    "apps/backend/.env.example",
    "compose.yaml",
    "compose.prod.yaml",
  ])("declares every feedback runtime setting in %s", (path) => {
    const contents = repositoryFile(path);

    for (const key of FEEDBACK_RUNTIME_ENVIRONMENT_KEYS) {
      expect(contents, `${path} is missing ${key}`).toMatch(
        new RegExp(`^\\s*${key}(?:=|:)`, "mu"),
      );
    }
  });

  it.each([".env.production.example", "apps/backend/.env.example"])(
    "pins Luna medium for conversation work and Terra high only for summaries in %s",
    (path) => {
      const contents = repositoryFile(path);

      expect(contents).toMatch(
        /^FEEDBACK_EXTRACTION_MODEL=openai\/gpt-5\.6-luna$/mu,
      );
      expect(contents).toMatch(
        /^FEEDBACK_EXTRACTION_REASONING_EFFORT=medium$/mu,
      );
      expect(contents).toMatch(/^FEEDBACK_REPLY_REASONING_EFFORT=medium$/mu);
      expect(contents).toMatch(
        /^FEEDBACK_ATTENTION_REASONING_EFFORT=medium$/mu,
      );
      expect(contents).toMatch(
        /^FEEDBACK_SUMMARY_MODEL=openai\/gpt-5\.6-terra$/mu,
      );
      expect(contents).toMatch(/^FEEDBACK_SUMMARY_REASONING_EFFORT=high$/mu);
    },
  );
});
