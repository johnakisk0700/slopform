/**
 * The machine-readable half of what a burst rehearsal leaves behind.
 *
 * The runner writes two files per run. `burst-report.mjs` renders the HTML an
 * operator reads once; this builds the JSON the *next* run is compared against,
 * and that copy is tracked in git — see the `report/` rules in `.gitignore`.
 *
 * It lives in its own module for one reason: the code that finishes a paid run is
 * the code that must never be the part nobody exercised. A run reaches this after
 * spending real money and half an hour of wall clock, so a mistake here is a
 * mistake discovered at the most expensive possible moment. Everything below is
 * therefore reachable from `scripts/burst-artefacts.spec.mjs` without a
 * rehearsal, which is not true of anything inside the runner's `main`.
 *
 * @see {@link ./run-feedback-burst.mjs}
 * @see {@link ./burst-ledger.mjs}
 */

import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * The `feedback_burst.finished` event, which goes to stdout and to disk unchanged.
 *
 * Two fields are worth explaining. `reportPath` is repo-relative because this
 * object is committed and an absolute path would make every run differ by whose
 * laptop produced it. `commit` and `dirty` are the whole reason the artefact is
 * tracked at all: the same model against a different tree is a different
 * experiment, and without them no two runs in the ledger are comparable.
 */
export function buildFinishedEvent({ result, stamp, reportPath, revision }) {
  const campaigns = result.campaigns ?? [];
  return {
    event: "feedback_burst.finished",
    passed: result.passed,
    model: result.model,
    // Named treatment is separate from the model/config pair: `prova` is the
    // operator contract that selected those exact values, not a label inferred
    // later from whichever values happened to be recorded.
    treatment: result.treatment ?? null,
    // Silence is deliberately safe but it is not behavioral coverage. Keep
    // the substitution visible in the tracked terminal event.
    liveGuests: result.liveGuests ?? null,
    stamp,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    durationMs: result.durationMs,
    commit: revision.commit,
    dirty: revision.dirty,
    findings: result.findings,
    reportPath,
    // Absent on every pre-usage artefact; null means "unavailable", never 0.
    tokenUsage: result.tokenUsage ?? null,
    costUsd: result.costUsd ?? null,
    // The knobs that shaped the run (reasoning efforts, service tier), resolved
    // from the same dist the workers load. Null on stub runs and on every
    // artefact written before the field existed — the ledger renders "?".
    config: result.config ?? null,
    conversations: campaigns.flatMap((campaign) =>
      (campaign.conversations ?? []).map((conversation) => ({
        personaId: conversation.personaId,
        displayName: conversation.displayName,
        passed: conversation.passed,
        lifecycle: conversation.actual?.lifecycle,
        closedBecause: conversation.actual?.closedBecause,
        // Observation, not verdict: where the fixture expected this to end and
        // whether the run agreed. Absent on pre-audit artefacts.
        expected: conversation.expected ?? null,
        lifecycleDiverged: conversation.lifecycleDiverged ?? null,
      })),
    ),
  };
}

/**
 * Writes the summary beside the HTML report and returns where it went.
 *
 * Pretty-printed and newline-terminated because it is a tracked file: a diff
 * between two runs should read as a few changed lines, not as one changed line
 * eight thousand characters wide.
 */
export async function writeRunSummary({ directory, stamp, event }) {
  const summaryPath = path.join(directory, `feedback-burst-${stamp}.json`);
  await writeFile(summaryPath, `${JSON.stringify(event, null, 2)}\n`, "utf8");
  return summaryPath;
}

/**
 * The commit the rehearsal ran against, and whether the tree it ran from had
 * uncommitted changes.
 *
 * Every failure mode here is the same failure mode — the answer is unknown — so
 * they all collapse to nulls rather than to an exception. A run that has already
 * spent its money must not fail at the final step because git is missing, because
 * this is an export rather than a checkout, or because an editor is holding the
 * index lock.
 *
 * `dirty` is null and not false in that case, because "we could not tell" and
 * "the tree was clean" are different claims and the ledger prints them
 * differently. Untracked files count as dirty: an uncommitted new module changes
 * the behaviour under test exactly as much as an edited one does.
 */
export async function readGitRevision(cwd) {
  try {
    const [head, status] = await Promise.all([
      execFileAsync("git", ["rev-parse", "HEAD"], { cwd }),
      execFileAsync("git", ["status", "--porcelain"], { cwd }),
    ]);
    return {
      commit: head.stdout.trim() || null,
      dirty: status.stdout.trim().length > 0,
    };
  } catch {
    return { commit: null, dirty: null };
  }
}
