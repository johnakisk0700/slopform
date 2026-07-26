#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const MONGO_WRITE_PATTERNS = [
  /\.(?:insertOne|insertMany|updateOne|updateMany|replaceOne)\s*\(/iu,
  /\.(?:deleteOne|deleteMany|findOneAndUpdate|findOneAndDelete)\s*\(/iu,
  /\.(?:bulkWrite|drop|dropDatabase|renameCollection|createIndex)\s*\(/iu,
  /\.(?:createCollection|remove|save)\s*\(/iu,
  /\b(?:insert|update|delete|drop|create|collMod|renameCollection)\s*:/iu,
];

const REDIS_READ_COMMANDS = new Set([
  "DBSIZE",
  "EXISTS",
  "GET",
  "HGET",
  "HGETALL",
  "HLEN",
  "HMGET",
  "HSCAN",
  "KEYS",
  "LINDEX",
  "LLEN",
  "LRANGE",
  "MGET",
  "PTTL",
  "SCAN",
  "SCARD",
  "SMEMBERS",
  "SSCAN",
  "TTL",
  "TYPE",
  "ZCARD",
  "ZRANGE",
  "ZRANK",
  "ZSCAN",
  "ZSCORE",
]);

const usage = `Local data query helper

Usage:
  pnpm db:query postgres '<SQL>'
  pnpm db:query mongo '<mongosh expression>'
  pnpm db:query redis <COMMAND> [ARG...]
  pnpm db:query --write <postgres|mongo|redis> <query or command>

Examples:
  pnpm db:query postgres 'select id, preferred_name from participants limit 5'
  pnpm db:query mongo 'db.feedback_conversations.findOne({}, {messages: 1})'
  pnpm db:query redis HGETALL feedback:extract:job-id
  pnpm db:query --write postgres "update feedback_campaigns set status='closed' where id='...'"

Read-only is the default. PostgreSQL enforces it with a read-only transaction.
MongoDB rejects known mutating APIs and Redis accepts only read commands unless
--write is present. The helper targets the local Docker Compose services only.`;

const arguments_ = process.argv.slice(2);
if (
  arguments_.length === 0 ||
  arguments_.includes("--help") ||
  arguments_.includes("-h")
) {
  process.stdout.write(`${usage}\n`);
  process.exit(0);
}

const writeIndex = arguments_.indexOf("--write");
const allowWrite = writeIndex !== -1;
if (allowWrite) {
  arguments_.splice(writeIndex, 1);
}

const [store, ...queryParts] = arguments_;
if (!["postgres", "mongo", "redis"].includes(store ?? "")) {
  fail(`Unknown store "${store ?? ""}".\n\n${usage}`);
}
if (queryParts.length === 0) {
  fail(`A query or command is required.\n\n${usage}`);
}

if (store === "postgres") {
  runPostgres(queryParts.join(" "), allowWrite);
} else if (store === "mongo") {
  runMongo(queryParts.join(" "), allowWrite);
} else {
  runRedis(queryParts, allowWrite);
}

function runPostgres(query, allowWrite) {
  if (/^\s*\\/mu.test(query)) {
    fail("psql meta-commands are not supported; pass SQL only.");
  }
  const input = allowWrite
    ? `${query}\n;\n`
    : `BEGIN TRANSACTION READ ONLY;\n${query}\n;\nROLLBACK;\n`;
  runCompose(
    [
      "exec",
      "-T",
      "postgres",
      "sh",
      "-lc",
      'PGPASSWORD="$POSTGRES_PASSWORD" exec psql --no-psqlrc --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB"',
    ],
    input,
  );
}

function runMongo(query, allowWrite) {
  if (!allowWrite && looksLikeMongoWrite(query)) {
    fail(
      "MongoDB mutation rejected. Re-run with --write after checking the target.",
    );
  }
  runCompose(
    [
      "exec",
      "-T",
      "mongo",
      "sh",
      "-lc",
      'exec mongosh --quiet --username "$MONGODB_APP_USER" --password "$MONGODB_APP_PASSWORD" --authenticationDatabase "$MONGO_INITDB_DATABASE" "$MONGO_INITDB_DATABASE" --file /dev/stdin',
    ],
    `(async () => {
  const __value = await (${query});
  if (__value && typeof __value.toArray === "function") {
    printjson(await __value.toArray());
  } else if (__value !== undefined) {
    printjson(__value);
  }
})().catch((error) => {
  console.error(error);
  quit(1);
});
`,
  );
}

function runRedis(parts, allowWrite) {
  const command = parts[0]?.toUpperCase();
  if (!allowWrite && !REDIS_READ_COMMANDS.has(command)) {
    fail(
      `Redis command ${command ?? ""} is not in the read-only allowlist. Re-run with --write after checking the target.`,
    );
  }
  runCompose(["exec", "-T", "redis", "redis-cli", "--raw", ...parts]);
}

function runCompose(arguments_, input) {
  const result = spawnSync("docker", ["compose", ...arguments_], {
    cwd: repositoryRoot,
    input,
    stdio: ["pipe", "inherit", "inherit"],
  });
  if (result.error) {
    fail(result.error.message);
  }
  process.exit(result.status ?? 1);
}

function looksLikeMongoWrite(query) {
  return MONGO_WRITE_PATTERNS.some((pattern) => pattern.test(query));
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}
