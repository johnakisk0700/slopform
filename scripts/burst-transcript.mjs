#!/usr/bin/env node

/**
 * Prints a rehearsal conversation exactly as it happened, end to end.
 *
 * Every other view of a run is a verdict: the HTML report says which
 * expectations failed, the answer diff says which answers went missing. Neither
 * tells you *what the bot said*, and that is almost always the thing you need in
 * order to decide whether a failure is the model's fault or the fixture's. This
 * is the tool for reading the words.
 *
 * Conversations are selected by a substring of the participant's name because
 * that is what an operator has in hand — a failing row in the report, a name in
 * a finding — and never a conversation id. Several substrings may be passed to
 * read several conversations in one go.
 *
 * The bot's opening message is printed rather than skipped. It is boilerplate
 * right up until it is not: it is generated per participant, and a rehearsal
 * where the greeting itself is wrong is exactly the kind of thing this is used
 * to find.
 *
 * Read-only: see `scripts/burst-inspect.mjs` for the scoping guarantee.
 */

import { openBurstInspection } from "./burst-inspect.mjs";

const usage = `Prints full burst-rehearsal transcripts.

Usage:
  pnpm feedback:burst:transcript <name-substring> [name-substring...]

Examples:
  pnpm feedback:burst:transcript Κώστας
  pnpm feedback:burst:transcript Μάκης Λούλα`;

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main() {
  const wanted = process.argv.slice(2).filter((argument) => argument !== "");

  const inspection = await openBurstInspection({
    applicationName: "burst-transcript",
  });
  try {
    if (wanted.length === 0) {
      // Listing the roster beside the usage saves the round trip through a
      // second tool: the names are Greek, long, and easy to mistype.
      console.log(usage);
      console.log("\nParticipants in the current rehearsal:");
      for (const name of inspection.nameById.values()) {
        console.log(`  ${name}`);
      }
      process.exitCode = 1;
      return;
    }

    const threads = (await inspection.findThreads()).filter((thread) => {
      const name = inspection.nameFor(thread);
      return wanted.some((needle) => name.includes(needle));
    });
    threads.sort((left, right) =>
      inspection.nameFor(left).localeCompare(inspection.nameFor(right), "el"),
    );

    if (threads.length === 0) {
      console.log(`No rehearsal conversation matched: ${wanted.join(", ")}`);
      process.exitCode = 1;
      return;
    }

    for (const thread of threads) {
      printThread(thread, inspection.nameFor(thread));
    }
  } finally {
    await inspection.close();
  }
}

function printThread(thread, name) {
  const lifecycle = thread.lifecycle ?? {};
  const closed = lifecycle.reason ? `/${lifecycle.reason}` : "";
  console.log(
    `\n===== ${name} · ${lifecycle.state ?? "?"}${closed} · needsAttention=${Boolean(
      thread.needsAttention,
    )} · opened ${isoOf(thread.createdAt)}`,
  );

  const goals = (thread.goals ?? [])
    .map((goal) => `${goal.key}=${goal.status}`)
    .join(" ");
  console.log(`goals: ${goals || "«none»"}`);

  for (const message of thread.messages ?? []) {
    // Multi-line bodies are indented rather than flattened onto one line: the
    // line breaks the bot chose are part of what is being reviewed.
    const body = String(message.text ?? "").trim() || "«empty»";
    const indented = body.split("\n").join("\n        ");
    console.log(`\n[${message.actor} ${timeOf(message.at)}] ${indented}`);
  }
}

/**
 * UTC throughout, and never the local format.
 *
 * The driver hands these back as BSON dates, so interpolating one directly
 * prints a locale string with a timezone offset in it, while the run's own log
 * lines and the report are UTC. Reading a transcript means lining its timestamps
 * up against those, and two clocks is one too many.
 */
function isoOf(value) {
  const at = new Date(value ?? "");
  return Number.isNaN(at.getTime()) ? "?" : at.toISOString();
}

/** Time of day only. The header already dates the conversation. */
function timeOf(value) {
  const iso = isoOf(value);
  return iso === "?" ? "??:??:??" : iso.slice(11, 19);
}
