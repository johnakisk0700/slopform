#!/usr/bin/env node

/**
 * Removes what a burst rehearsal leaves behind — and nothing else.
 *
 * The runner refuses to reuse a campaign whose conversations have moved past the
 * intro-only baseline, so a second rehearsal needs the first one's campaigns
 * gone. This is that step, and it is deliberately narrow: the local database
 * also holds real imported participants with real phone numbers, so every
 * statement here is scoped to the reserved block `+3069000<cc><pp>` that
 * `burst-scenario.ts` owns, or to the campaigns those participants sit in.
 *
 * Kept on purpose:
 * - `participants` and `events` — the seeder re-finds them by phone and title,
 *   so deleting them would only churn ids for no gain.
 * - `audit_events` — an append-only ledger. Rows pointing at deleted entities
 *   are the honest record of a rehearsal that happened; they block nothing.
 *
 * Redis matters more than it looks: `findFailedJobs` reads the failed set, so a
 * previous run's failures would be reported as the next run's if left behind.
 *
 * Prints the plan and exits unless `--yes` is passed.
 */

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/** The block `burstPhoneE164` allocates. Nothing outside it is ever touched. */
const RESERVED_PHONE_PREFIX = "+3069000";

/** Campaigns of every event a reserved-block participant attends. */
const BURST_CAMPAIGN_IDS = `
  select c.id from feedback_campaigns c
  where c.event_id in (
    select distinct a.event_id
    from event_attendees a
    join participants p on p.id = a.participant_id
    where p.phone_e164 like '${RESERVED_PHONE_PREFIX}%'
  )`;

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main() {
  const apply = process.argv.includes("--yes");

  const plan = queryPostgres(`
    select 'feedback_campaigns' as target, count(*)::int as rows from feedback_campaigns where id in (${BURST_CAMPAIGN_IDS})
    union all select 'feedback_answers', count(*)::int from feedback_answers where campaign_id in (${BURST_CAMPAIGN_IDS})
    union all select 'feedback_notes', count(*)::int from feedback_notes where campaign_id in (${BURST_CAMPAIGN_IDS})
    union all select 'message_outbox', count(*)::int from message_outbox where campaign_id in (${BURST_CAMPAIGN_IDS})
    union all select 'feedback_sim_outbound', count(*)::int from feedback_sim_outbound where phone_e164 like '${RESERVED_PHONE_PREFIX}%'
    union all select 'provider_message_ingress', count(*)::int from provider_message_ingress where phone_e164 like '${RESERVED_PHONE_PREFIX}%'
    order by 1`);

  console.log("Postgres (scoped to the reserved phone block):");
  console.log(plan.trim());

  const campaignIds = queryPostgres(
    `select string_agg(id::text, ',') from (${BURST_CAMPAIGN_IDS}) as c`,
  )
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[0-9a-f-]{36}(,[0-9a-f-]{36})*$/iu.test(line))
    .flatMap((line) => line.split(","));

  const threadCount = campaignIds.length
    ? queryMongo(
        `db.conversation_threads.countDocuments({campaignId:{$in:${JSON.stringify(campaignIds)}}})`,
      ).trim()
    : "0";
  console.log(
    `\nMongo conversation_threads in those campaigns: ${threadCount}`,
  );

  const queues = await openFeedbackQueues();
  for (const queue of queues) {
    console.log(
      `Redis ${queue.name}: ${await queue.getFailedCount()} failed, ${await queue.getCompletedCount()} completed`,
    );
  }

  if (!apply) {
    await Promise.all(queues.map((queue) => queue.close()));
    console.log("\nNothing changed. Re-run with --yes to apply.");
    return;
  }

  // One transaction: a half-deleted campaign is worse than an undeleted one,
  // and the foreign keys are RESTRICT, so order is load-bearing.
  writePostgres(`
    begin;
    delete from feedback_answers where campaign_id in (${BURST_CAMPAIGN_IDS});
    delete from feedback_notes where campaign_id in (${BURST_CAMPAIGN_IDS});
    delete from feedback_sim_outbound where phone_e164 like '${RESERVED_PHONE_PREFIX}%';
    delete from message_outbox where campaign_id in (${BURST_CAMPAIGN_IDS});
    delete from feedback_campaigns where id in (${BURST_CAMPAIGN_IDS});
    delete from provider_message_ingress where phone_e164 like '${RESERVED_PHONE_PREFIX}%';
    commit;`);
  console.log("\nPostgres: burst rows removed.");

  if (campaignIds.length) {
    writeMongo(
      `db.conversation_threads.deleteMany({campaignId:{$in:${JSON.stringify(campaignIds)}}})`,
    );
    console.log("Mongo: conversation threads removed.");
  }

  for (const queue of queues) {
    // Only the terminal sets. `delayed` holds the recurring relay and sweeps,
    // which belong to the running workers and are not rehearsal residue.
    await queue.clean(0, 10_000, "failed");
    await queue.clean(0, 10_000, "completed");
    await queue.close();
    console.log(`Redis ${queue.name}: failed and completed jobs cleared.`);
  }
}

/**
 * Both feedback queues, named and prefixed from the backend so they read the
 * app's key space. Materialization lives on its own queue, so a run leaves
 * residue in two places.
 */
async function openFeedbackQueues() {
  const redisUrl = String(process.env.REDIS_URL ?? "").trim();
  if (!redisUrl) {
    return [];
  }
  const backendRequire = createRequire(
    path.join(repositoryRoot, "apps/backend/package.json"),
  );
  const { Queue } = backendRequire("bullmq");
  const { FEEDBACK_INGRESS_QUEUE, FEEDBACK_QUEUE, QUEUE_PREFIX } = await import(
    path.join(
      repositoryRoot,
      "apps/backend/dist/infrastructure/queue/queue.constants.js",
    )
  );
  const url = new URL(redisUrl);
  const connection = {
    host: url.hostname,
    port: url.port ? Number(url.port) : 6379,
    db: url.pathname.slice(1) ? Number(url.pathname.slice(1)) : 0,
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
    maxRetriesPerRequest: 1,
  };
  return [FEEDBACK_QUEUE, FEEDBACK_INGRESS_QUEUE].map(
    (name) => new Queue(name, { prefix: QUEUE_PREFIX, connection }),
  );
}

function queryPostgres(sql) {
  return runQueryTool(["postgres", sql]);
}

function writePostgres(sql) {
  return runQueryTool(["--write", "postgres", sql]);
}

function queryMongo(expression) {
  return runQueryTool(["mongo", expression]);
}

function writeMongo(expression) {
  return runQueryTool(["--write", "mongo", expression]);
}

/**
 * Everything goes through the repository's own query tool rather than a second
 * connection strategy: it already owns the credentials and the read-only guard,
 * and `--write` is the one documented way past that guard.
 */
function runQueryTool(args) {
  const result = spawnSync(
    process.execPath,
    [path.join(repositoryRoot, "scripts/local-data-query.mjs"), ...args],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(
      `db:query ${args[0]} failed: ${result.stderr || result.stdout}`,
    );
  }
  return result.stdout;
}
