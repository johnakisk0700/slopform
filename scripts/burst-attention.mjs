#!/usr/bin/env node

/**
 * Every rehearsal conversation the module flagged for a human, one line each.
 *
 * `needsAttention` is the module's own judgement that a conversation stopped
 * being safe to leave with the bot, and it is the signal most worth watching
 * across runs: a change in the reasons — or in how many conversations raise one
 * at all — is how a regression in the safety rules shows up before any
 * expectation fails. The runner only asserts the flag per persona, so a run can
 * pass while the *reasons* quietly change underneath it.
 *
 * The hostility counter is printed beside the reasons because the two are easy
 * to confuse: a conversation can be abandoned to a human without a single
 * hostile turn, and can absorb several hostile turns without ever being handed
 * over.
 *
 * Read-only: see `scripts/burst-inspect.mjs` for the scoping guarantee.
 */

import { openBurstInspection } from "./burst-inspect.mjs";

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main() {
  const inspection = await openBurstInspection({
    applicationName: "burst-attention",
  });
  try {
    const flagged = await inspection.findThreads({ needsAttention: true });
    const rows = flagged
      .map((thread) => ({
        name: inspection.nameFor(thread),
        // Reasons a staff member has cleared stay on the document as history,
        // so they are marked rather than dropped: a conversation still flagged
        // while all of its reasons are resolved is itself worth noticing.
        kinds:
          (thread.attentionReasons ?? [])
            .map((reason) =>
              reason.resolvedAt ? `${reason.kind} (resolved)` : reason.kind,
            )
            .join(", ") || "«none»",
        // The lifecycle's close reason is `reason`, not `closedBecause`. The
        // throwaway version of this script read the latter and therefore printed
        // a dash for every closed conversation it listed.
        lifecycle: `${thread.lifecycle?.state ?? "?"}/${
          thread.lifecycle?.reason ?? "-"
        }`,
        hostileTurns: thread.hostileTurns ?? 0,
      }))
      .sort((left, right) => left.name.localeCompare(right.name, "el"));

    for (const row of rows) {
      console.log(
        `${row.name.padEnd(28)} ${row.kinds.padEnd(30)} [${row.lifecycle}]  hostileTurns=${row.hostileTurns}`,
      );
    }
    console.log(`\n${rows.length} rehearsal conversation(s) need attention.`);
  } finally {
    await inspection.close();
  }
}
