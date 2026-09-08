#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (!process.env.FEEDBACK_POSTGRES_TEST_URL) {
  throw new Error(
    "Set FEEDBACK_POSTGRES_TEST_URL to a disposable PostgreSQL database; this test applies migrations.",
  );
}

const backend = fileURLToPath(new URL("../apps/backend", import.meta.url));
const commands = [
  [
    "pnpm",
    [
      "exec",
      "vitest",
      "run",
      "src/modules/post-event-feedback/post-event-feedback-conversation.repository.spec.ts",
    ],
  ],
  [
    "pnpm",
    [
      "exec",
      "vitest",
      "run",
      "../../harness/feedback/outbox/dispatcher.repository.spec.ts",
      "--config",
      "../../harness/vitest.config.ts",
      "--root",
      "../../harness",
    ],
  ],
  [
    "pnpm",
    [
      "exec",
      "vitest",
      "run",
      "../../harness/feedback/outbox/dispatch-context-migration.spec.ts",
      "--config",
      "../../harness/vitest.config.ts",
      "--root",
      "../../harness",
    ],
  ],
  [
    "pnpm",
    [
      "exec",
      "vitest",
      "run",
      "src/modules/post-event-feedback/topic-analysis/topic-analysis.repository.spec.ts",
    ],
  ],
  [
    process.execPath,
    [
      "--test",
      fileURLToPath(
        new URL(
          "../scripts/import-feedback-conversations.spec.mjs",
          import.meta.url,
        ),
      ),
    ],
  ],
];

for (const [command, args] of commands) {
  const result = spawnSync(command, args, {
    cwd: backend,
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
