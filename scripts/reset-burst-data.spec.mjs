import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  classifyResetQueueJobs,
  resolveResetScope,
} from "./reset-burst-data.mjs";

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptsDirectory, "..");
const resetSource = readFileSync(
  path.join(scriptsDirectory, "reset-burst-data.mjs"),
  "utf8",
);
const feedbackSchemaSource = readFileSync(
  path.join(
    repositoryRoot,
    "packages/database/src/schema/post-event-feedback.ts",
  ),
  "utf8",
);

function campaignChildTables() {
  const tables = [];
  const tablePattern =
    /export const \w+ = pgTable\(\n\s*"([^"]+)",[\s\S]*?(?=\nexport const |\nexport type |$)/gu;

  for (const match of feedbackSchemaSource.matchAll(tablePattern)) {
    if (match[0].includes("foreignColumns: [feedbackCampaigns.id]")) {
      tables.push(match[1]);
    }
  }

  return tables.sort();
}

test("burst reset plans and deletes every RESTRICT child of feedback campaigns", () => {
  const childTables = campaignChildTables();
  assert.deepEqual(childTables, [
    "feedback_answer_withdrawals",
    "feedback_answers",
    "feedback_campaign_summaries",
    "feedback_notes",
    "message_outbox",
    "message_outbox_log",
  ]);

  const campaignDeleteAt = resetSource.indexOf(
    "delete from feedback_campaigns where",
  );
  assert.notEqual(campaignDeleteAt, -1);

  for (const table of childTables) {
    assert.match(
      resetSource,
      new RegExp(`union all select '${table}'`, "u"),
      `${table} must be visible in the dry-run plan`,
    );
    const childDeleteAt = resetSource.indexOf(`delete from ${table} where`);
    assert.notEqual(childDeleteAt, -1, `${table} must be deleted`);
    assert.ok(
      childDeleteAt < campaignDeleteAt,
      `${table} must be deleted before feedback_campaigns`,
    );
  }

  assert.ok(
    resetSource.indexOf("delete from message_outbox_log where") <
      resetSource.indexOf("delete from message_outbox where"),
    "message_outbox_log must be deleted before its parent outbox row",
  );
});

test("burst reset preserves reusable seed identities and the audit ledger", () => {
  assert.doesNotMatch(resetSource, /delete from (?:participants|events)\b/u);
  assert.doesNotMatch(resetSource, /delete from audit_events\b/u);
  assert.match(resetSource, /if \(!apply\)/u);
  assert.match(resetSource, /scope\.applyFlags/u);
  assert.match(resetSource, /refuses NODE_ENV=production/u);
});

test("Mongo cleanup remains retryable after PostgreSQL campaign deletion", () => {
  assert.match(resetSource, /phoneAtLaunch:\{\$gte:[\s\S]*\$lt:/u);
  assert.doesNotMatch(
    resetSource,
    /conversation_threads\.(?:countDocuments|deleteMany)\(\{campaignId:/u,
  );
});

test("queue reset permits only delayed repeat schedulers", () => {
  const jobs = [
    {
      state: "delayed",
      id: "repeat:relay:1",
      name: "feedback.relay-outbox.v1",
      repeatJobKey: "feedback.relay-outbox.v1",
    },
    {
      state: "delayed",
      id: "feedback-extract-1",
      name: "feedback.extract.v1",
      repeatJobKey: null,
    },
    {
      state: "active",
      id: "repeat:expiry:1",
      name: "feedback.sweep-expiry.v1",
      repeatJobKey: "feedback.sweep-expiry.v1",
    },
    {
      state: "wait",
      id: "feedback-ingress-1",
      name: "feedback.materialize-inbound.v1",
      repeatJobKey: null,
    },
  ];

  const classified = classifyResetQueueJobs(jobs);
  assert.deepEqual(
    classified.repeatSchedulers.map((job) => job.id),
    ["repeat:relay:1"],
  );
  assert.deepEqual(
    classified.unsafeJobs.map((job) => job.id),
    ["feedback-extract-1", "repeat:expiry:1", "feedback-ingress-1"],
  );
});

test("all-feedback mode keeps non-feedback identities and assistant threads", () => {
  const scope = resolveResetScope(["--all-feedback"]);

  assert.equal(scope.campaignIdsSql, "select id from feedback_campaigns");
  assert.equal(scope.simOutboundPredicate, "true");
  assert.equal(scope.ingressPredicate, "true");
  assert.equal(scope.mongoFilter, '{purpose:"post_event_feedback"}');
  assert.equal(scope.applyFlags, "--all-feedback --yes");
  assert.doesNotMatch(scope.mongoFilter, /admin_assistant/u);
});
