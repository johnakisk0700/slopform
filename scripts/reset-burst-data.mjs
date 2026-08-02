#!/usr/bin/env node

/**
 * Removes what a burst rehearsal leaves behind — and nothing else by default.
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
 * `--all-feedback` widens the local-only scope to every post-event feedback
 * campaign and thread while still preserving events, participants, assistant
 * conversations and audit. Prints the plan and exits unless `--yes` is passed.
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
const RESERVED_PHONE_UPPER_BOUND = "+3069001";

const NON_TERMINAL_QUEUE_STATES = [
  "wait",
  "active",
  "prioritized",
  "waiting-children",
  "paused",
  "delayed",
];

/** Campaigns of every event a reserved-block participant attends. */
const BURST_CAMPAIGN_IDS = `
  select c.id from feedback_campaigns c
  where c.event_id in (
    select distinct a.event_id
    from event_attendees a
    join participants p on p.id = a.participant_id
    where p.phone_e164 like '${RESERVED_PHONE_PREFIX}%'
  )`;
const ALL_FEEDBACK_CAMPAIGN_IDS = `select id from feedback_campaigns`;

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

async function main() {
  const arguments_ = process.argv.slice(2);
  const unknownArguments = arguments_.filter(
    (argument) => argument !== "--yes" && argument !== "--all-feedback",
  );
  if (unknownArguments.length > 0) {
    throw new Error(`Unknown reset option: ${unknownArguments.join(", ")}`);
  }
  if (process.env.NODE_ENV?.trim().toLowerCase() === "production") {
    throw new Error(
      "Feedback reset is local-only and refuses NODE_ENV=production",
    );
  }

  const apply = arguments_.includes("--yes");
  const scope = resolveResetScope(arguments_);

  const plan = queryPostgres(`
    select 'feedback_campaigns' as target, count(*)::int as rows from feedback_campaigns where id in (${scope.campaignIdsSql})
    union all select 'feedback_answer_withdrawals', count(*)::int from feedback_answer_withdrawals where campaign_id in (${scope.campaignIdsSql})
    union all select 'feedback_answers', count(*)::int from feedback_answers where campaign_id in (${scope.campaignIdsSql})
    union all select 'feedback_campaign_summaries', count(*)::int from feedback_campaign_summaries where campaign_id in (${scope.campaignIdsSql})
    union all select 'feedback_notes', count(*)::int from feedback_notes where campaign_id in (${scope.campaignIdsSql})
    union all select 'message_outbox', count(*)::int from message_outbox where campaign_id in (${scope.campaignIdsSql})
    union all select 'message_outbox_log', count(*)::int from message_outbox_log where campaign_id in (${scope.campaignIdsSql})
    union all select 'feedback_sim_outbound', count(*)::int from feedback_sim_outbound where ${scope.simOutboundPredicate}
    union all select 'provider_message_ingress', count(*)::int from provider_message_ingress where ${scope.ingressPredicate}
    order by 1`);

  console.log(`Postgres (${scope.label}):`);
  console.log(plan.trim());

  // Scope Mongo independently of PostgreSQL. If PostgreSQL commits and Mongo
  // is temporarily unavailable, a retry must still find and remove the same
  // threads after their campaign rows are gone.
  const threadCount = queryMongo(
    `db.conversation_threads.countDocuments(${scope.mongoFilter})`,
  ).trim();
  console.log(`\nMongo ${scope.mongoLabel}: ${threadCount}`);

  const queues = await openFeedbackQueues();
  const unsafeQueueJobs = [];
  for (const queue of queues) {
    const queueState = await inspectQueueForReset(queue);
    unsafeQueueJobs.push(
      ...queueState.unsafeJobs.map((job) => ({ queue: queue.name, ...job })),
    );
    console.log(
      `Redis ${queue.name}: ${queueState.failed} failed, ${queueState.completed} completed, ${queueState.unsafeJobs.length} unsafe nonterminal, ${queueState.repeatSchedulers.length} delayed repeat schedulers`,
    );
  }

  if (unsafeQueueJobs.length > 0) {
    await Promise.all(queues.map((queue) => queue.close()));
    const jobs = unsafeQueueJobs
      .map(
        (job) => `${job.queue}/${job.state}/${job.name}/${job.id ?? "no-id"}`,
      )
      .join(", ");
    throw new Error(
      `Refusing reset while nonterminal feedback jobs exist. Stop API/workers and settle or remove these jobs first: ${jobs}`,
    );
  }

  if (!apply) {
    await Promise.all(queues.map((queue) => queue.close()));
    console.log(`\nNothing changed. Re-run with ${scope.applyFlags} to apply.`);
    return;
  }

  // One transaction: a half-deleted campaign is worse than an undeleted one,
  // and the foreign keys are RESTRICT, so order is load-bearing.
  writePostgres(`
    begin;
    delete from feedback_answer_withdrawals where campaign_id in (${scope.campaignIdsSql});
    delete from feedback_answers where campaign_id in (${scope.campaignIdsSql});
    delete from feedback_campaign_summaries where campaign_id in (${scope.campaignIdsSql});
    delete from feedback_notes where campaign_id in (${scope.campaignIdsSql});
    delete from feedback_sim_outbound where ${scope.simOutboundPredicate};
    delete from message_outbox_log where campaign_id in (${scope.campaignIdsSql});
    delete from message_outbox where campaign_id in (${scope.campaignIdsSql});

    delete from feedback_campaigns where id in (${scope.campaignIdsSql});
    delete from provider_message_ingress where ${scope.ingressPredicate};
    commit;`);
  console.log(`\nPostgres: ${scope.deletedLabel} removed.`);

  writeMongo(`db.conversation_threads.deleteMany(${scope.mongoFilter})`);
  console.log(`Mongo: ${scope.mongoLabel} removed.`);

  for (const queue of queues) {
    // Only the terminal sets. `delayed` holds the recurring relay and sweeps,
    // which belong to the running workers and are not rehearsal residue.
    await queue.clean(0, 10_000, "failed");
    await queue.clean(0, 10_000, "completed");
    await queue.close();
    console.log(`Redis ${queue.name}: failed and completed jobs cleared.`);
  }
}

export function resolveResetScope(arguments_) {
  if (arguments_.includes("--all-feedback")) {
    return {
      label: "all local post-event feedback",
      campaignIdsSql: ALL_FEEDBACK_CAMPAIGN_IDS,
      simOutboundPredicate: "true",
      ingressPredicate: "true",
      mongoFilter: '{purpose:"post_event_feedback"}',
      mongoLabel: "post-event feedback conversation_threads",
      deletedLabel: "all local post-event feedback rows",
      applyFlags: "--all-feedback --yes",
    };
  }

  return {
    label: "scoped to the reserved phone block",
    campaignIdsSql: BURST_CAMPAIGN_IDS,
    simOutboundPredicate: `phone_e164 like '${RESERVED_PHONE_PREFIX}%'`,
    ingressPredicate: `phone_e164 like '${RESERVED_PHONE_PREFIX}%'`,
    mongoFilter: `{phoneAtLaunch:{$gte:${JSON.stringify(RESERVED_PHONE_PREFIX)},$lt:${JSON.stringify(RESERVED_PHONE_UPPER_BOUND)}}}`,
    mongoLabel: "conversation_threads in the reserved phone block",
    deletedLabel: "burst rows",
    applyFlags: "--yes",
  };
}

async function inspectQueueForReset(queue) {
  const [failed, completed, jobsByState] = await Promise.all([
    queue.getFailedCount(),
    queue.getCompletedCount(),
    Promise.all(
      NON_TERMINAL_QUEUE_STATES.map(async (state) =>
        (await queue.getJobs([state], 0, -1, true)).map((job) => ({
          state,
          id: job.id,
          name: job.name,
          repeatJobKey: job.repeatJobKey ?? null,
        })),
      ),
    ),
  ]);
  const { unsafeJobs, repeatSchedulers } = classifyResetQueueJobs(
    jobsByState.flat(),
  );
  return { failed, completed, unsafeJobs, repeatSchedulers };
}

export function classifyResetQueueJobs(jobs) {
  const repeatSchedulers = jobs.filter(
    (job) => job.state === "delayed" && Boolean(job.repeatJobKey),
  );
  const repeatSchedulerIds = new Set(
    repeatSchedulers.map((job) => `${job.state}:${job.id}`),
  );
  const unsafeJobs = jobs.filter(
    (job) => !repeatSchedulerIds.has(`${job.state}:${job.id}`),
  );
  return { unsafeJobs, repeatSchedulers };
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
