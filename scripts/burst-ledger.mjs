#!/usr/bin/env node

/**
 * The rehearsal ledger: one line per burst run, generated from the artefacts.
 *
 * The runner writes `report/feedback-burst-<stamp>.json` beside its HTML and
 * those files are tracked, so the history of the rehearsal is a property of the
 * repository rather than of one laptop. This reads all of them and prints the
 * comparison table — which model, against which commit, how many conversations,
 * how many of them failed, how long it took, what was found.
 *
 * It is deliberately a *view* and not a document. A hand-maintained ledger drifts
 * the first time somebody is in a hurry at two in the morning, which is when
 * these runs actually happen; a generated one cannot disagree with the runs it
 * describes.
 *
 * `formatLedger` is exported and pure so the column logic can be tested without
 * a rehearsal: see `scripts/burst-ledger.spec.mjs`.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/**
 * Only the runner's own summaries. `report/` also collects output from unrelated
 * tools — a jscpd duplication report lives there today — and a ledger that tried
 * to read those would fail on the first one it met.
 */
const SUMMARY_PATTERN = /^feedback-burst-.+\.json$/u;

const COLUMNS = [
  { key: "stamp", label: "stamp" },
  { key: "model", label: "model" },
  { key: "commit", label: "commit" },
  { key: "tree", label: "tree" },
  { key: "verdict", label: "verdict" },
  { key: "conversations", label: "conv", align: "right" },
  { key: "passedRows", label: "pass", align: "right" },
  { key: "failedRows", label: "fail", align: "right" },
  { key: "duration", label: "duration", align: "right" },
  { key: "cost", label: "cost", align: "right" },
  { key: "findings", label: "findings" },
];

if (isEntryPoint()) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

async function main() {
  const reportDirectory = path.join(repositoryRoot, "report");
  const runs = await readSummaries(reportDirectory);
  console.log(formatLedger(runs));
}

/**
 * Every summary in `directory`, oldest first. A file that will not parse is
 * reported and skipped rather than fatal: one truncated artefact from a run that
 * was killed mid-write must not hide the other fifteen.
 */
export async function readSummaries(directory) {
  let entries;
  try {
    entries = await readdir(directory);
  } catch {
    return [];
  }

  const runs = [];
  for (const entry of entries.filter((name) => SUMMARY_PATTERN.test(name))) {
    const file = path.join(directory, entry);
    try {
      const summary = JSON.parse(await readFile(file, "utf8"));
      // Older artefacts, and any produced by hand, may carry no stamp of their
      // own. The filename always has one, and it is the same string.
      summary.stamp ??= entry
        .replace(/^feedback-burst-/u, "")
        .replace(/\.json$/u, "");
      runs.push(summary);
    } catch (error) {
      console.error(
        `skipping ${entry}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return runs;
}

/**
 * The whole table as one string, oldest run first.
 *
 * Column widths come from the content because model ids and finding kinds vary
 * in length by a factor of three, and a fixed width either truncates the useful
 * part or wastes half the terminal.
 */
export function formatLedger(runs) {
  if (runs.length === 0) {
    return "No burst-run summaries in report/. Run pnpm feedback:burst to make one.";
  }

  const rows = [...runs]
    .sort((left, right) =>
      String(left.stamp).localeCompare(String(right.stamp)),
    )
    .map(toRow);

  const widths = new Map(
    COLUMNS.map((column) => [
      column.key,
      Math.max(
        column.label.length,
        ...rows.map((row) => String(row[column.key]).length),
      ),
    ]),
  );

  const lines = [
    renderRow(Object.fromEntries(COLUMNS.map((c) => [c.key, c.label])), widths),
    renderRow(
      Object.fromEntries(
        COLUMNS.map((column) => [
          column.key,
          "-".repeat(widths.get(column.key)),
        ]),
      ),
      widths,
    ),
    ...rows.map((row) => renderRow(row, widths)),
  ];

  const passed = rows.filter((row) => row.verdict === "PASS").length;
  lines.push(
    "",
    `${rows.length} run(s) · ${passed} passed · ${rows.length - passed} failed`,
  );
  return lines.join("\n");
}

function toRow(run) {
  const conversations = Array.isArray(run.conversations)
    ? run.conversations
    : [];
  const passedRows = conversations.filter(
    (conversation) => conversation.passed,
  ).length;

  return {
    stamp: String(run.stamp ?? "?"),
    model: String(run.model ?? "?"),
    // Seven characters is what everybody pastes into a commit lookup, and the
    // full forty is in the artefact for anybody who needs it.
    commit: run.commit ? String(run.commit).slice(0, 7) : "?",
    // Three states, not two: a null means git could not be read, which is not
    // the same claim as a clean tree.
    tree:
      run.dirty === null || run.dirty === undefined
        ? "?"
        : run.dirty
          ? "dirty"
          : "clean",
    // The run's own verdict, which is not implied by the failure count: a run
    // with every conversation passing still fails on a cross-cutting finding.
    verdict: run.passed ? "PASS" : "FAIL",
    conversations: String(conversations.length),
    passedRows: String(passedRows),
    failedRows: String(conversations.length - passedRows),
    duration: formatDuration(run.durationMs),
    // Older summaries never recorded a cost; "?" is the same claim as an
    // unknown duration — not "$0.00".
    cost: formatCost(run.costUsd),
    findings: formatFindings(run.findings),
  };
}

/** `$X.XX` when the artefact has a finite cost; "?" when it does not. */
function formatCost(costUsd) {
  if (typeof costUsd !== "number" || !Number.isFinite(costUsd)) {
    return "?";
  }
  return `$${costUsd.toFixed(2)}`;
}

/**
 * Finding kinds with their multiplicities rather than their details. The detail
 * of a finding is a sentence naming a conversation, which belongs in the report;
 * what a ledger answers is whether the same *kind* of thing keeps happening.
 */
function formatFindings(findings) {
  if (!Array.isArray(findings) || findings.length === 0) {
    return "none";
  }
  const counts = new Map();
  for (const finding of findings) {
    const kind = String(finding?.kind ?? "unknown");
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return [...counts]
    .map(([kind, count]) => (count === 1 ? kind : `${kind}×${count}`))
    .join(" ");
}

/** Human units. Runs range from about four minutes to over half an hour. */
function formatDuration(durationMs) {
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs)) {
    return "?";
  }
  const totalSeconds = Math.round(durationMs / 1_000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) {
    return `${minutes}m${String(totalSeconds % 60).padStart(2, "0")}s`;
  }
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

function renderRow(row, widths) {
  return COLUMNS.map((column) => {
    const value = String(row[column.key]);
    return column.align === "right"
      ? value.padStart(widths.get(column.key))
      : value.padEnd(widths.get(column.key));
  })
    .join("  ")
    .trimEnd();
}

/**
 * True when this file was run rather than imported. The spec imports it for the
 * pure formatting functions and must not trigger a directory read.
 */
function isEntryPoint() {
  return (
    process.argv[1] !== undefined &&
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  );
}
