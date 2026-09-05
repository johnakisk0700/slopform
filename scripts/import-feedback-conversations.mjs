#!/usr/bin/env node

/**
 * Offline copy of schema-v2 Mongo feedback documents onto
 * `feedback_conversations`.
 *
 * Dry-run is the default. `--apply` also requires
 * `--acknowledge-quiesced-writers`: HTTP and worker writers must already be
 * stopped. The script never deletes MongoDB documents and never overwrites a
 * destination row that already differs.
 *
 * Environment is loaded only by the root `pnpm import:feedback-conversations`
 * command. This file does not read `.env` itself.
 */

import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

export const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

export const SOURCE_FILTER = Object.freeze({
  schemaVersion: 2,
  purpose: "post_event_feedback",
});

export const APPLY_ACKNOWLEDGEMENT = "--acknowledge-quiesced-writers";

export const DOCUMENT_MODULE_PATH = path.join(
  repositoryRoot,
  "apps/backend/dist/modules/post-event-feedback/post-event-feedback-conversation.document.js",
);

export const PERSISTENCE_MODULE_PATH = path.join(
  repositoryRoot,
  "apps/backend/dist/modules/post-event-feedback/post-event-feedback-conversation.persistence.js",
);

const CONVERSATION_COLLECTION = "conversation_threads";

const INSERT_COLUMNS = [
  "id",
  "campaign_id",
  "respondent_participant_id",
  "phone_at_launch",
  "lifecycle_state",
  "lifecycle_reason",
  "closed_at",
  "terminal_outbox_id",
  "staff_close_reason",
  "staff_close_note",
  "control_mode",
  "control_source",
  "control_changed_at",
  "needs_attention",
  "awaiting_human",
  "hostile_turns",
  "extraction_fallback_ack_sent",
  "reminder_count",
  "reminded_at",
  "cursor_seq",
  "extraction_last_run_at",
  "extraction_model",
  "extraction_service_tier",
  "parked_since",
  "parked_runs",
  "parked_notice_sent_at",
  "work_revision",
  "work_next_action_at",
  "messages",
  "goals",
  "attention_reasons",
  "extraction_usage",
  "created_at",
  "updated_at",
];

const usage = `Copy schema-v2 Mongo feedback documents onto feedback_conversations.

Usage:
  pnpm import:feedback-conversations
  pnpm import:feedback-conversations --apply ${APPLY_ACKNOWLEDGEMENT}

Dry-run is the default. --apply refuses unless writers are acknowledged as
quiesced. Source documents are never deleted. Divergent destination rows abort
the run without overwrite.`;

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

async function main() {
  const options = parseImportArguments(process.argv.slice(2));
  if (options.help) {
    console.log(usage);
    return;
  }

  const modules = await loadFeedbackConversationModules();
  const documentToRow = resolveDocumentToRow(modules.persistence);
  const connections = await openImportConnections();
  try {
    const summary = await importFeedbackConversations({
      ...connections,
      documentSchema: modules.documentSchema,
      documentToRow,
      apply: options.apply,
    });
    printImportSummary(summary, options.apply);
    if (
      summary.reject.length > 0 ||
      summary.invalid.length > 0 ||
      summary.missingParents.length > 0
    ) {
      process.exitCode = 1;
    }
  } finally {
    await connections.close();
  }
}

export function parseImportArguments(arguments_) {
  const unknown = arguments_.filter(
    (argument) =>
      argument !== "--apply" &&
      argument !== APPLY_ACKNOWLEDGEMENT &&
      argument !== "--help" &&
      argument !== "-h",
  );
  if (unknown.length > 0) {
    throw new Error(`Unknown import option: ${unknown.join(", ")}`);
  }

  const help = arguments_.includes("--help") || arguments_.includes("-h");
  const apply = arguments_.includes("--apply");
  const acknowledged = arguments_.includes(APPLY_ACKNOWLEDGEMENT);
  if (apply && !acknowledged) {
    throw new Error(
      `--apply requires ${APPLY_ACKNOWLEDGEMENT} after feedback HTTP and worker writers are stopped.`,
    );
  }
  if (acknowledged && !apply) {
    throw new Error(
      `${APPLY_ACKNOWLEDGEMENT} is only valid together with --apply.`,
    );
  }

  return { apply, help };
}

export async function loadFeedbackConversationModules() {
  const documentModule = await import(pathToFileURL(DOCUMENT_MODULE_PATH).href);
  if (
    typeof documentModule.feedbackConversationDocumentSchema?.parse !==
    "function"
  ) {
    throw new Error(
      "Compiled feedback conversation document schema is missing. Run the root import command so the backend build runs first.",
    );
  }
  let persistence;
  try {
    persistence = await import(pathToFileURL(PERSISTENCE_MODULE_PATH).href);
  } catch (error) {
    throw new Error(
      `Compiled feedback persistence mapper is missing at ${path.relative(repositoryRoot, PERSISTENCE_MODULE_PATH)}. Build the backend before running the import.`,
      { cause: error },
    );
  }
  return {
    documentSchema: documentModule.feedbackConversationDocumentSchema,
    persistence,
  };
}

export function resolveDocumentToRow(persistence) {
  if (typeof persistence.toLaunchInsert !== "function") {
    throw new Error(
      "Build the backend before importing feedback conversations.",
    );
  }
  return (document) =>
    canonicalConversationRow(persistence.toLaunchInsert(document));
}

export function canonicalConversationRow(row) {
  return Object.fromEntries(
    INSERT_COLUMNS.map((column) => {
      const camel = column.replace(/_([a-z])/gu, (_, letter) =>
        letter.toUpperCase(),
      );
      const value = Object.hasOwn(row, column) ? row[column] : row[camel];
      return [column, stableValue(value ?? null)];
    }),
  );
}

function stableValue(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

// Run the retired compatibility repairs once during cutover, before new workers
// can see these rows. Scheduling uses persisted dates so dry-run/apply/replay agree.
export function prepareImportedDocument(document, campaign) {
  const operatorEvidence =
    document.attentionReasons.some(
      (reason) =>
        reason.resolvedAt === null &&
        [
          "handoff",
          "unfinished_questionnaire",
          "hostile_to_bot",
          "undelivered_message",
        ].includes(reason.kind),
    ) ||
    document.messages.some(
      (message) =>
        message.attention?.recommendedAction === "urgent_human_follow_up",
    );
  const unreadTestimony = document.messages.some(
    (message) =>
      message.actor === "participant" &&
      message.seq > document.extraction.cursorSeq,
  );
  const awaitingHuman =
    document.awaitingHuman ||
    (document.lifecycle.state === "open" &&
      document.control.mode === "bot" &&
      document.control.source !== "staff_action" &&
      operatorEvidence &&
      !unreadTestimony);
  let work = document.work ?? {
    revision: 0,
    nextActionAt: null,
    executionEpoch: 0,
  };
  const missingSchedule =
    !document.work && document.control.mode === "bot" && !awaitingHuman;
  const pendingResume =
    (work.campaignResumeGeneration ?? 0) < campaign.resume_generation;
  if (
    document.lifecycle.state === "open" &&
    (missingSchedule || pendingResume)
  ) {
    const dueAt = new Date(
      Math.max(
        document.updatedAt.getTime(),
        new Date(campaign.updated_at).getTime(),
        work.nextActionAt?.getTime() ?? 0,
      ),
    );
    work = { ...work, revision: work.revision + 1, nextActionAt: dueAt };
  }
  return { ...document, awaitingHuman, work };
}

export function conversationRowsMatch(left, right) {
  return (
    JSON.stringify(canonicalConversationRow(left)) ===
    JSON.stringify(canonicalConversationRow(right))
  );
}

export function classifyImportDecision(existingRow, plannedRow) {
  if (!existingRow) {
    return "insert";
  }
  return conversationRowsMatch(existingRow, plannedRow) ? "skip" : "reject";
}

export async function importFeedbackConversations(input) {
  const sources = await input.collection
    .find({
      schemaVersion: SOURCE_FILTER.schemaVersion,
      purpose: SOURCE_FILTER.purpose,
    })
    .toArray();

  const summary = {
    source: sources.length,
    insert: [],
    skip: [],
    reject: [],
    invalid: [],
    missingParents: [],
    fenceInsert: [],
  };

  const planned = [];
  for (const raw of sources) {
    const identity = conversationIdentity(raw);
    let document;
    try {
      document = input.documentSchema.parse(raw);
    } catch (error) {
      summary.invalid.push({
        ...identity,
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    const campaign = await input.pool.query(
      "select id, resume_generation, updated_at from feedback_campaigns where id = $1",
      [document.campaignId],
    );
    const participant = await input.pool.query(
      "select id from participants where id = $1",
      [document.respondentParticipantId],
    );
    if (!campaign.rows[0] || !participant.rows[0]) {
      summary.missingParents.push({
        ...identity,
        reason: !campaign.rows[0] ? "campaign" : "respondent",
      });
      continue;
    }
    const row = input.documentToRow(
      prepareImportedDocument(document, campaign.rows[0]),
    );
    planned.push({ identity, row });
  }

  for (const item of planned) {
    const existing = await input.pool.query(
      `select ${INSERT_COLUMNS.join(", ")}
         from feedback_conversations
        where id = $1
           or (campaign_id = $2 and respondent_participant_id = $3)
           or ($4 = 'open' and lifecycle_state = 'open' and phone_at_launch = $5)`,
      [
        item.row.id,
        item.row.campaign_id,
        item.row.respondent_participant_id,
        item.row.lifecycle_state,
        item.row.phone_at_launch,
      ],
    );
    const decision = existing.rows.some((row) => row.id !== item.row.id)
      ? "reject"
      : classifyImportDecision(existing.rows[0], item.row);
    if (decision === "reject") {
      summary.reject.push({
        ...item.identity,
        reason: "destination row differs from the validated source document",
      });
      continue;
    }
    if (decision === "skip") {
      summary.skip.push(item.identity);
    } else {
      summary.insert.push(item.identity);
    }

    const fence = await input.pool.query(
      `select conversation_id
         from feedback_conversation_executions
        where conversation_id = $1`,
      [item.row.id],
    );
    if (fence.rows.length === 0) {
      summary.fenceInsert.push(item.identity);
    }
  }

  const blocked =
    summary.invalid.length > 0 ||
    summary.reject.length > 0 ||
    summary.missingParents.length > 0;
  if (!input.apply || blocked) {
    return summary;
  }

  const insertById = new Map(planned.map((item) => [item.row.id, item.row]));
  const client = await input.pool.connect();
  try {
    await client.query("begin");
    for (const identity of summary.insert) {
      const row = insertById.get(identity.id);
      await client.query(
        `insert into feedback_conversations (${INSERT_COLUMNS.join(", ")})
         values (${INSERT_COLUMNS.map((_, index) => `$${index + 1}`).join(", ")})`,
        INSERT_COLUMNS.map((column) => bindColumn(row[column])),
      );
    }
    for (const identity of summary.fenceInsert) {
      const row =
        insertById.get(identity.id) ??
        planned.find((item) => item.identity.id === identity.id)?.row;
      await client.query(
        `insert into feedback_conversation_executions
           (conversation_id, epoch, work_revision)
         values ($1, 0, $2)
         on conflict (conversation_id) do nothing`,
        [identity.id, row?.work_revision ?? 0],
      );
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  return summary;
}

function printImportSummary(summary, apply) {
  const mode = apply ? "apply" : "dry-run";
  console.log(
    `Feedback conversation import (${mode}): source=${summary.source} insert=${summary.insert.length} skip=${summary.skip.length} reject=${summary.reject.length} invalid=${summary.invalid.length} missingParents=${summary.missingParents.length} fenceInsert=${summary.fenceInsert.length}`,
  );
  for (const item of summary.invalid) {
    console.log(`invalid ${item.id}: ${item.reason}`);
  }
  for (const item of summary.reject) {
    console.log(`reject ${item.id}: ${item.reason}`);
  }
  for (const item of summary.missingParents) {
    console.log(`missing parent ${item.id}: ${item.reason}`);
  }
  if (!apply) {
    console.log(
      `Nothing changed. Re-run with --apply ${APPLY_ACKNOWLEDGEMENT} after writers are stopped.`,
    );
  }
}

async function openImportConnections() {
  const databaseUrl = requireEnvironment("DATABASE_URL");
  const mongoUri = requireEnvironment("MONGODB_URI");
  const mongoDatabase = requireEnvironment("MONGODB_DB");
  const { createDatabase } = await import(
    path.join(repositoryRoot, "packages/database/dist/index.js")
  );
  const { MongoClient } = loadMongoDriver();
  const { pool } = createDatabase({
    connectionString: databaseUrl,
    applicationName: "import-feedback-conversations",
    maxConnections: 2,
  });
  const mongo = new MongoClient(mongoUri);
  try {
    await mongo.connect();
    return {
      pool,
      collection: mongo.db(mongoDatabase).collection(CONVERSATION_COLLECTION),
      async close() {
        await mongo.close().catch(() => undefined);
        await pool.end().catch(() => undefined);
      },
    };
  } catch (error) {
    await mongo.close().catch(() => undefined);
    await pool.end().catch(() => undefined);
    throw error;
  }
}

function loadMongoDriver() {
  const backendRequire = createRequire(
    path.join(repositoryRoot, "apps/backend/package.json"),
  );
  return backendRequire("mongodb");
}

function conversationIdentity(raw) {
  return {
    id: typeof raw?._id === "string" ? raw._id : String(raw?._id ?? "unknown"),
    campaignId:
      typeof raw?.campaignId === "string" ? raw.campaignId : undefined,
  };
}

function bindColumn(value) {
  if (value !== null && typeof value === "object" && !(value instanceof Date)) {
    return JSON.stringify(value);
  }
  return value;
}

function requireEnvironment(name) {
  const value = String(process.env[name] ?? "").trim();
  if (!value) {
    throw new Error(
      `${name} is not set. Run this through pnpm so dotenv loads .env.`,
    );
  }
  return value;
}
