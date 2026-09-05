import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  APPLY_ACKNOWLEDGEMENT,
  DOCUMENT_MODULE_PATH,
  PERSISTENCE_MODULE_PATH,
  SOURCE_FILTER,
  classifyImportDecision,
  conversationRowsMatch,
  canonicalConversationRow,
  prepareImportedDocument,
  importFeedbackConversations,
  parseImportArguments,
  resolveDocumentToRow,
} from "./import-feedback-conversations.mjs";

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptsDirectory, "..");
const importSource = readFileSync(
  path.join(scriptsDirectory, "import-feedback-conversations.mjs"),
  "utf8",
);

const sampleDocument = {
  _id: "11111111-1111-4111-8111-111111111111",
  campaignId: "22222222-2222-4222-8222-222222222222",
  respondentParticipantId: "33333333-3333-4333-8333-333333333333",
  phoneAtLaunch: "+306900000001",
  lifecycle: { state: "open", reason: null, closedAt: null },
  staffClose: null,
  control: {
    mode: "bot",
    source: "launch",
    changedAt: new Date("2026-09-01T10:00:00.000Z"),
  },
  needsAttention: false,
  awaitingHuman: false,
  hostileTurns: 0,
  extractionFallbackAckSent: false,
  reminderCount: 0,
  remindedAt: null,
  extraction: {
    cursorSeq: 1,
    lastRunAt: new Date("2026-09-01T10:05:00.000Z"),
    model: "test-model",
    serviceTier: null,
    parkedSince: null,
    parkedRuns: 0,
    parkedNoticeSentAt: null,
    usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
  },
  work: {
    revision: 3,
    executionEpoch: 0,
    nextActionAt: new Date("2026-09-01T10:10:00.000Z"),
  },
  messages: [
    {
      id: "44444444-4444-4444-8444-444444444444",
      seq: 1,
      actor: "bot",
      text: "secret transcript",
      at: new Date("2026-09-01T10:00:00.000Z"),
    },
  ],
  goals: [
    { key: "event_score", ordinal: 1, prompt: "score?", status: "asked" },
  ],
  attentionReasons: [],
  createdAt: new Date("2026-09-01T10:00:00.000Z"),
  updatedAt: new Date("2026-09-01T10:05:00.000Z"),
};

test("dry-run is the default and apply requires quiesced-writer acknowledgement", () => {
  assert.deepEqual(parseImportArguments([]), { apply: false, help: false });
  assert.deepEqual(parseImportArguments(["--apply", APPLY_ACKNOWLEDGEMENT]), {
    apply: true,
    help: false,
  });
  assert.throws(
    () => parseImportArguments(["--apply"]),
    /acknowledge-quiesced-writers/,
  );
  assert.throws(
    () => parseImportArguments([APPLY_ACKNOWLEDGEMENT]),
    /together with --apply/,
  );
  assert.throws(
    () => parseImportArguments(["--force"]),
    /Unknown import option/,
  );
});

test("source filter is schema-v2 post-event feedback only", () => {
  assert.deepEqual(SOURCE_FILTER, {
    schemaVersion: 2,
    purpose: "post_event_feedback",
  });
  assert.match(importSource, /schemaVersion: SOURCE_FILTER\.schemaVersion/u);
  assert.match(importSource, /purpose: SOURCE_FILTER\.purpose/u);
  assert.doesNotMatch(importSource, /admin_assistant/u);
});

test("import uses the compiled persistence mapper and never deletes Mongo", () => {
  const persistenceSource = readFileSync(
    path.join(
      repositoryRoot,
      "apps/backend/src/modules/post-event-feedback/post-event-feedback-conversation.persistence.ts",
    ),
    "utf8",
  );
  assert.match(persistenceSource, /export function toLaunchInsert/u);
  assert.match(persistenceSource, /export function serializeConversationJson/u);
  assert.ok(DOCUMENT_MODULE_PATH.startsWith(repositoryRoot));
  assert.ok(
    PERSISTENCE_MODULE_PATH.endsWith(
      "post-event-feedback-conversation.persistence.js",
    ),
  );
  assert.match(importSource, /resolveDocumentToRow/u);
  assert.match(importSource, /toLaunchInsert/u);
  assert.match(importSource, /documentToRow/u);
  assert.doesNotMatch(
    importSource,
    /deleteMany|drop\(|delete from conversation/u,
  );
  assert.doesNotMatch(
    importSource,
    /from ["']dotenv|require\(["']dotenv|dotenv\.config/u,
  );
  assert.match(importSource, /createRequire\(/u);
  assert.match(importSource, /apps\/backend\/package\.json/u);
});

test("import logs identities and never interpolates transcripts or secrets", () => {
  assert.doesNotMatch(
    importSource,
    /message\.text|transcript|WASENDER|password/u,
  );
  assert.match(importSource, /invalid \$\{item\.id\}/u);
  assert.match(importSource, /reject \$\{item\.id\}/u);
});

test("resolveDocumentToRow prefers the storage document mapper", () => {
  const mapped = resolveDocumentToRow({
    toLaunchInsert(document) {
      return { id: document._id, campaignId: "from-mapper" };
    },
  })(sampleDocument);
  assert.equal(mapped.id, sampleDocument._id);
  assert.equal(mapped.campaign_id, "from-mapper");
});

test("identical destination rows skip; divergent rows reject", () => {
  const planned = canonicalConversationRow({
    id: sampleDocument._id,
    campaignId: sampleDocument.campaignId,
    messages: sampleDocument.messages,
    extractionUsage: sampleDocument.extraction.usage,
  });

  assert.equal(classifyImportDecision(undefined, planned), "insert");
  assert.equal(classifyImportDecision(planned, planned), "skip");
  assert.equal(
    classifyImportDecision({ ...planned, work_revision: 99 }, planned),
    "reject",
  );
  assert.ok(conversationRowsMatch(planned, { ...planned }));
});

test("JSONB object key ordering does not make an identical import divergent", () => {
  const planned = {
    id: sampleDocument._id,
    messages: [{ seq: 1, text: "hello", at: "2026-09-01T10:00:00.000Z" }],
  };
  const stored = {
    id: sampleDocument._id,
    messages: [{ at: "2026-09-01T10:00:00.000Z", text: "hello", seq: 1 }],
  };
  assert.ok(conversationRowsMatch(planned, stored));
  assert.ok(!conversationRowsMatch(planned, { ...stored, messages: [] }));
});

const campaign = {
  resume_generation: 0,
  updated_at: new Date("2026-09-01T10:06:00Z"),
};

test("import seeds missing work and completes an interrupted campaign resume deterministically", () => {
  const legacy = { ...sampleDocument, work: undefined };
  const seeded = prepareImportedDocument(legacy, campaign);
  assert.equal(seeded.work.revision, 1);
  assert.equal(
    seeded.work.nextActionAt.toISOString(),
    "2026-09-01T10:06:00.000Z",
  );
  assert.deepEqual(seeded, prepareImportedDocument(legacy, campaign));
  const resumed = prepareImportedDocument(sampleDocument, {
    ...campaign,
    resume_generation: 1,
  });
  assert.equal(resumed.work.revision, 4);
  assert.equal(
    resumed.work.nextActionAt.toISOString(),
    "2026-09-01T10:10:00.000Z",
  );
  assert.deepEqual(resumed.messages, sampleDocument.messages);
  assert.deepEqual(resumed.extraction, sampleDocument.extraction);
});

test("legacy consumed handoff evidence restores the brake, but staff resume remains authoritative", () => {
  const legacy = {
    ...sampleDocument,
    work: undefined,
    attentionReasons: [{ kind: "handoff", resolvedAt: null }],
  };
  const parked = prepareImportedDocument(legacy, campaign);
  assert.equal(parked.awaitingHuman, true);
  assert.equal(parked.work.nextActionAt, null);
  const resumed = prepareImportedDocument(
    { ...legacy, control: { ...legacy.control, source: "staff_action" } },
    campaign,
  );
  assert.equal(resumed.awaitingHuman, false);
  const unread = prepareImportedDocument(
    { ...legacy, messages: [{ actor: "participant", seq: 2 }] },
    campaign,
  );
  assert.equal(unread.awaitingHuman, false);
});

function importHarness({ invalid = false, divergent = false } = {}) {
  const commands = [];
  const query = async (sql) => {
    commands.push(sql.trim());
    if (sql.includes("from feedback_campaigns")) return { rows: [campaign] };
    if (sql.includes("from participants"))
      return { rows: [{ id: sampleDocument.respondentParticipantId }] };
    if (sql.includes("from feedback_conversations"))
      return { rows: divergent ? [{ id: "different" }] : [] };
    return { rows: [] };
  };
  const client = {
    query,
    release() {
      commands.push("release");
    },
  };
  const pool = {
    query,
    async connect() {
      commands.push("connect");
      return client;
    },
  };
  const input = {
    collection: {
      find() {
        return {
          async toArray() {
            return [sampleDocument];
          },
        };
      },
    },
    documentSchema: {
      parse(value) {
        if (invalid) throw new Error("invalid shape");
        return value;
      },
    },
    documentToRow: (document) =>
      canonicalConversationRow({
        id: document._id,
        campaignId: document.campaignId,
        respondentParticipantId: document.respondentParticipantId,
        messages: document.messages,
        workRevision: document.work.revision,
      }),
    pool,
  };
  return { input, commands, client };
}

test("dry-run and rejected apply make no writes", async () => {
  for (const options of [{}, { invalid: true }, { divergent: true }]) {
    const { input, commands } = importHarness(options);
    await importFeedbackConversations({
      ...input,
      apply: Object.keys(options).length > 0,
    });
    assert.ok(!commands.includes("connect"));
    assert.ok(
      !commands.some((sql) => /^(begin|insert|update|delete)/iu.test(sql)),
    );
  }
});

test("apply uses one checked-out connection and rolls back before releasing on failure", async () => {
  const { input, commands, client } = importHarness();
  const query = client.query;
  client.query = async (sql) => {
    if (sql.includes("insert into feedback_conversation_executions"))
      throw new Error("fence insert failed");
    return query(sql);
  };
  await assert.rejects(
    importFeedbackConversations({ ...input, apply: true }),
    /fence insert failed/u,
  );
  assert.ok(commands.includes("begin"));
  assert.deepEqual(commands.slice(-2), ["rollback", "release"]);
  assert.ok(!commands.includes("commit"));
});

test(
  "real PostgreSQL import preserves the aggregate and replays without overwriting",
  {
    skip: !process.env.FEEDBACK_POSTGRES_TEST_URL,
  },
  async () => {
    const { createRequire } = await import("node:module");
    const requireDatabase = createRequire(
      new URL("../packages/database/package.json", import.meta.url),
    );
    const { migrate } = requireDatabase("drizzle-orm/node-postgres/migrator");
    const { createDatabase } =
      await import("../packages/database/dist/index.js");
    const { loadFeedbackConversationModules } =
      await import("./import-feedback-conversations.mjs");
    const modules = await loadFeedbackConversationModules();
    const client = createDatabase({
      connectionString: process.env.FEEDBACK_POSTGRES_TEST_URL,
      applicationName: "feedback-import-test",
      maxConnections: 2,
    });
    const eventId = "66666666-6666-4666-8666-666666666666";
    const raw = {
      ...sampleDocument,
      schemaVersion: 2,
      purpose: "post_event_feedback",
      channel: "whatsapp",
      messages: [
        {
          ...sampleDocument.messages[0],
          actor: "participant",
          attention: null,
          ingressId: "55555555-5555-4555-8555-555555555555",
          outboxId: null,
          providerMessageId: null,
        },
      ],
    };
    const source = [raw];
    const input = {
      pool: client.pool,
      collection: {
        find() {
          return {
            async toArray() {
              return source;
            },
          };
        },
      },
      documentSchema: modules.documentSchema,
      documentToRow: resolveDocumentToRow(modules.persistence),
    };
    try {
      await migrate(client.db, {
        migrationsFolder: path.join(
          repositoryRoot,
          "packages/database/drizzle",
        ),
      });
      await client.pool.query(
        "insert into participants (id, email_normalized) values ($1, $2)",
        [raw.respondentParticipantId, "feedback-import-test@example.test"],
      );
      await client.pool.query(
        "insert into events (id, title, starts_at, status) values ($1, $2, $3, 'finished')",
        [eventId, "Import fixture", raw.createdAt],
      );
      await client.pool.query(
        "insert into feedback_campaigns (id, event_id, question_set_version, questions, launched_at, launched_by) values ($1, $2, 2, '{}'::jsonb, $3, 'import-test')",
        [raw.campaignId, eventId, raw.createdAt],
      );

      const dryRun = await importFeedbackConversations({
        ...input,
        apply: false,
      });
      assert.deepEqual(dryRun.invalid, []);
      assert.equal(dryRun.insert.length, 1);
      assert.equal(
        (
          await client.pool.query(
            "select id from feedback_conversations where id = $1",
            [raw._id],
          )
        ).rows.length,
        0,
      );
      const applied = await importFeedbackConversations({
        ...input,
        apply: true,
      });
      assert.equal(applied.insert.length, 1);
      const replay = await importFeedbackConversations({
        ...input,
        apply: true,
      });
      assert.equal(replay.skip.length, 1);
      assert.equal(replay.reject.length, 0);
      assert.equal(replay.fenceInsert.length, 0);

      const stored = (
        await client.pool.query(
          "select * from feedback_conversations where id = $1",
          [raw._id],
        )
      ).rows[0];
      assert.ok(
        conversationRowsMatch(
          stored,
          input.documentToRow(modules.documentSchema.parse(raw)),
        ),
      );
      assert.equal(stored.messages[0].text, raw.messages[0].text);
      assert.deepEqual(stored.extraction_usage, raw.extraction.usage);
      source[0] = {
        ...raw,
        messages: [{ ...raw.messages[0], text: "different content" }],
      };
      const divergent = await importFeedbackConversations({
        ...input,
        apply: true,
      });
      assert.equal(divergent.reject.length, 1);
      const unchanged = (
        await client.pool.query(
          "select * from feedback_conversations where id = $1",
          [raw._id],
        )
      ).rows[0];
      assert.ok(conversationRowsMatch(stored, unchanged));
    } finally {
      await client.pool.query(
        "delete from feedback_conversations where id = $1",
        [raw._id],
      );
      await client.pool.query(
        "delete from feedback_conversation_executions where conversation_id = $1",
        [raw._id],
      );
      await client.pool.query("delete from feedback_campaigns where id = $1", [
        raw.campaignId,
      ]);
      await client.pool.query("delete from events where id = $1", [eventId]);
      await client.pool.query("delete from participants where id = $1", [
        raw.respondentParticipantId,
      ]);
      await client.pool.end();
    }
  },
);
