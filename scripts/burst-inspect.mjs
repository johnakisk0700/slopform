/**
 * Shared, read-only access to what a burst rehearsal left in the databases.
 *
 * The three inspection scripts beside this file all need the same four things:
 * a Postgres pool, the Mongo conversation collection, the reserved-block
 * participants that a rehearsal owns, and a way to turn a participant id back
 * into a readable name. Repeating that in each of them is how the throwaway
 * versions of these scripts drifted apart — one of them scoped its queries and
 * two of them did not.
 *
 * Two things this file exists to guarantee rather than merely encourage:
 *
 * 1. **Scoping is structural.** The local databases hold real imported
 *    participants with real phone numbers next to the rehearsal's. `findThreads`
 *    therefore applies the reserved-block participant set *after* the caller's
 *    filter, so no filter a caller writes can widen the query to a real person.
 *    The reserved block is the same `+3069000<cc><pp>` that `burst-scenario.ts`
 *    owns and that `scripts/reset-burst-data.mjs` deletes within.
 * 2. **Nothing here writes.** Only `pool.query` with select statements and
 *    `collection.find` are reachable from this module, which is what lets these
 *    scripts be run against a half-finished rehearsal without a second thought.
 *
 * @see {@link ./reset-burst-data.mjs}
 * @see {@link ../apps/backend/src/modules/post-event-feedback/burst/burst-scenario.ts}
 */

import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/** The block `burstPhoneE164` allocates. Nothing outside it is ever read. */
export const RESERVED_PHONE_PREFIX = "+3069000";

/** The collection the feedback module materializes conversations into. */
const CONVERSATION_COLLECTION = "conversation_threads";

/**
 * The MongoDB driver, resolved the way `reset-burst-data.mjs` resolves bullmq:
 * as a dependency of the workspace that actually declares it. `mongodb` is a
 * direct dependency of `apps/backend`, so a require rooted at that package's
 * manifest gets whatever version the lockfile installed. The throwaway versions
 * of these scripts imported it by its literal path inside
 * `node_modules/.pnpm/mongodb@<version>/`, which every version bump breaks and
 * which pnpm gives no promise about in the first place.
 */
function loadMongoDriver() {
  const backendRequire = createRequire(
    path.join(repositoryRoot, "apps/backend/package.json"),
  );
  return backendRequire("mongodb");
}

/**
 * Opens both databases and reads the rehearsal's participant roster once.
 *
 * The roster is read up front because every one of these scripts needs to put a
 * name next to a conversation, and a per-conversation lookup would be dozens of
 * round trips for a table that is at most a few dozen rows.
 */
export async function openBurstInspection({
  applicationName = "burst-inspect",
} = {}) {
  const databaseUrl = requireEnvironment("DATABASE_URL");
  const mongoUri = requireEnvironment("MONGODB_URI");
  const mongoDatabase = requireEnvironment("MONGODB_DB");

  const { createDatabase } = await import(
    path.join(repositoryRoot, "packages/database/dist/index.js")
  );
  const { MongoClient } = loadMongoDriver();

  const { pool } = createDatabase({
    connectionString: databaseUrl,
    applicationName,
    maxConnections: 2,
  });

  let mongo;
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

    mongo = new MongoClient(mongoUri);
    await mongo.connect();
    const collection = mongo
      .db(mongoDatabase)
      .collection(CONVERSATION_COLLECTION);

    return {
      pool,
      nameById,

      /** The rehearsal's participant ids, in preferred-name order. */
      participantIds: [...nameById.keys()],

      /**
       * Conversations matching `filter`, never more. The reserved-block clause
       * is spread last on purpose: it overrides rather than merges with any
       * `respondentParticipantId` a caller passes, so the widest query this can
       * run is "every rehearsal conversation".
       */
      async findThreads(filter = {}) {
        return collection
          .find({
            ...filter,
            respondentParticipantId: { $in: [...nameById.keys()] },
          })
          .toArray();
      },

      /** The name to print for a conversation, or a marker when it is a stranger. */
      nameFor(thread) {
        return nameById.get(thread.respondentParticipantId) ?? "«unknown»";
      },

      async close() {
        await mongo.close().catch(() => undefined);
        await pool.end().catch(() => undefined);
      },
    };
  } catch (error) {
    await mongo?.close().catch(() => undefined);
    await pool.end().catch(() => undefined);
    throw error;
  }
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
