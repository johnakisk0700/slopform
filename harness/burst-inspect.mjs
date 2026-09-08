/**
 * Shared, read-only access to what a burst rehearsal left in the databases.
 *
 * The inspection scripts beside this file all need the same three things: a
 * Postgres pool, the reserved-block participants that a rehearsal owns, and a
 * way to turn a participant id back into a readable name. Repeating that in
 * each of them is how the throwaway versions of these scripts drifted apart.
 *
 * Two things this file exists to guarantee rather than merely encourage:
 *
 * 1. **Scoping is structural.** The local databases hold real imported
 *    participants with real phone numbers next to the rehearsal's. `findThreads`
 *    therefore applies the reserved-block participant set *after* the caller's
 *    filter, so no filter a caller writes can widen the query to a real person.
 *    The reserved block is the same `+3069000<cc><pp>` that `burst-scenario.ts`
 *    owns and that `harness/reset-burst-data.mjs` deletes within.
 * 2. **Nothing here writes.** Only `pool.query` with select statements is
 *    reachable from this module, which is what lets these scripts be run
 *    against a half-finished rehearsal without a second thought.
 *
 * Campaign conversations live on `feedback_conversations`. Assistant threads
 * in MongoDB are out of scope and are never opened here.
 *
 * @see {@link ./reset-burst-data.mjs}
 * @see {@link ../apps/backend/src/modules/post-event-feedback/burst/burst-scenario.ts}
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

export const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/** The block `burstPhoneE164` allocates. Nothing outside it is ever read. */
export const RESERVED_PHONE_PREFIX = "+3069000";

const ALLOWED_THREAD_FILTERS = new Set(["needsAttention"]);

/**
 * Opens Postgres and reads the rehearsal's participant roster once.
 *
 * The roster is read up front because every one of these scripts needs to put a
 * name next to a conversation, and a per-conversation lookup would be dozens of
 * round trips for a table that is at most a few dozen rows.
 */
export async function openBurstInspection({
  applicationName = "burst-inspect",
} = {}) {
  const databaseUrl = requireEnvironment("DATABASE_URL");

  const { createDatabase } = await import(
    path.join(repositoryRoot, "packages/database/dist/index.js")
  );

  const { pool } = createDatabase({
    connectionString: databaseUrl,
    applicationName,
    maxConnections: 2,
  });

  try {
    const roster = await pool.query(
      `select id, preferred_name
         from participants
        where phone_e164 like $1
        order by preferred_name`,
      [`${RESERVED_PHONE_PREFIX}%`],
    );
    const nameById = new Map(
      roster.rows.map((row) => [row.id, row.preferred_name]),
    );
    const participantIds = [...nameById.keys()];

    return {
      pool,
      nameById,

      /** The rehearsal's participant ids, in preferred-name order. */
      participantIds,

      /**
       * Conversations matching `filter`, never more. The reserved-block clause
       * is applied last on purpose: it overrides rather than merges with any
       * respondent a caller passes, so the widest query this can run is
       * "every rehearsal conversation".
       */
      async findThreads(filter = {}) {
        return findReservedConversations(pool, participantIds, filter);
      },

      /** The name to print for a conversation, or a marker when it is a stranger. */
      nameFor(thread) {
        return nameById.get(thread.respondentParticipantId) ?? "«unknown»";
      },

      async close() {
        await pool.end().catch(() => undefined);
      },
    };
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw error;
  }
}

/**
 * Builds the reserved-block conversation query. Exported so the scoping
 * contract can be tested without opening a database.
 */
export function reservedConversationQuery(filter = {}) {
  const unknown = Object.keys(filter).filter(
    (key) => !ALLOWED_THREAD_FILTERS.has(key),
  );
  if (unknown.length > 0) {
    throw new Error(
      `Burst inspection refuses filter keys that could widen the query: ${unknown.join(", ")}`,
    );
  }

  const conditions = ["respondent_participant_id = any($1::uuid[])"];
  if (filter.needsAttention === true) {
    conditions.push("needs_attention is true");
  }

  return {
    text: `select id,
                  campaign_id,
                  respondent_participant_id,
                  phone_at_launch,
                  lifecycle_state,
                  lifecycle_reason,
                  needs_attention,
                  hostile_turns,
                  created_at,
                  messages,
                  goals,
                  attention_reasons
             from feedback_conversations
            where ${conditions.join(" and ")}
            order by created_at`,
  };
}

export function conversationRowToInspectionThread(row) {
  return {
    _id: row.id,
    campaignId: row.campaign_id,
    respondentParticipantId: row.respondent_participant_id,
    phoneAtLaunch: row.phone_at_launch,
    lifecycle: {
      state: row.lifecycle_state,
      reason: row.lifecycle_reason,
    },
    needsAttention: row.needs_attention,
    hostileTurns: row.hostile_turns,
    createdAt: row.created_at,
    messages: row.messages ?? [],
    goals: row.goals ?? [],
    attentionReasons: row.attention_reasons ?? [],
  };
}

async function findReservedConversations(pool, participantIds, filter) {
  if (participantIds.length === 0) {
    return [];
  }
  const query = reservedConversationQuery(filter);
  const result = await pool.query(query.text, [participantIds]);
  return result.rows.map((row) => conversationRowToInspectionThread(row));
}

/**
 * These scripts are wired through `dotenv -e .env` in the root manifest because
 * the repository `.env` contains a value POSIX `source` cannot parse, so a shell
 * `. .env` silently leaves half the file unset. Failing loudly on a missing key
 * is what tells the difference between that and a genuinely absent variable.
 */
function requireEnvironment(name) {
  const value = String(process.env[name] ?? "").trim();
  if (!value) {
    throw new Error(
      `${name} is not set. Run this through pnpm so dotenv loads .env.`,
    );
  }
  return value;
}
