/**
 * Specs for the burst rehearsal ledger.
 *
 * `node:test` rather than vitest, for the reason given at the top of
 * `scripts/burst-report.spec.mjs`: `scripts/` is outside every workspace, so
 * `turbo run test` never reaches it and vitest is not resolvable here.
 *
 * The ledger is the one place where a run's history is read rather than written,
 * so the cases below are mostly about artefacts that are *not* pristine: a run
 * from before a field existed, a summary truncated by a killed process, a tree
 * whose state could not be determined.
 */

import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { formatLedger, readSummaries } from "./burst-ledger.mjs";

describe("formatLedger", () => {
  it("prints one line per run, oldest first", () => {
    const lines = formatLedger([
      run({ stamp: "2026-07-28T06-37-03Z", model: "openai/gpt-5.6-terra" }),
      run({ stamp: "2026-07-27T07-49-13Z", model: "stub/burst-rehearsal" }),
    ]).split("\n");

    assert.match(lines[0], /^stamp\s+model\s+commit\s+tree\s+verdict/u);
    assert.ok(lines[2].startsWith("2026-07-27T07-49-13Z"));
    assert.ok(lines[3].startsWith("2026-07-28T06-37-03Z"));
  });

  it("counts passing and failing conversations separately", () => {
    const line = rowFor(
      run({
        conversations: [
          { passed: true },
          { passed: true },
          { passed: false },
          { passed: false },
          { passed: false },
        ],
      }),
    );
    // conv, pass, fail — five conversations, two of them good.
    assert.match(line, /\s5\s+2\s+3\s/u);
  });

  it("shows a run that failed on a finding alone as FAIL", () => {
    // The failure count says zero and the verdict still has to say FAIL, which
    // is the entire reason the verdict is its own column.
    const line = rowFor(
      run({
        passed: false,
        conversations: [{ passed: true }],
        findings: [{ kind: "duplicate_outbound" }],
      }),
    );
    assert.match(line, /FAIL/u);
    assert.match(line, /\s1\s+1\s+0\s/u);
    assert.match(line, /duplicate_outbound$/u);
  });

  it("groups repeated finding kinds with a multiplicity", () => {
    const line = rowFor(
      run({
        findings: [
          { kind: "job_failed" },
          { kind: "job_failed" },
          { kind: "lost_participant_text" },
        ],
      }),
    );
    assert.match(line, /job_failed×2 lost_participant_text$/u);
  });

  it("says none rather than zero when a run found nothing", () => {
    assert.match(rowFor(run({ findings: [] })), /none$/u);
  });

  it("distinguishes a dirty tree, a clean tree and an unknown one", () => {
    assert.match(rowFor(run({ dirty: true })), /\sdirty\s/u);
    assert.match(rowFor(run({ dirty: false })), /\sclean\s/u);
    // A run whose git state could not be read must not be reported as clean:
    // that would be a claim the artefact never made.
    assert.match(rowFor(run({ dirty: null, commit: null })), /\?\s+\?\s/u);
  });

  it("shortens the commit to what a person pastes into a lookup", () => {
    assert.match(
      rowFor(run({ commit: "79eb586c1d4f0a2b3e5d6c7a8b9e0f1a2b3c4d5e" })),
      /\s79eb586\s/u,
    );
  });

  it("formats durations in units a person reads", () => {
    assert.match(rowFor(run({ durationMs: 41_000 })), /\s41s\s/u);
    assert.match(rowFor(run({ durationMs: 879_000 })), /\s14m39s\s/u);
    assert.match(rowFor(run({ durationMs: 3_720_000 })), /\s1h02m\s/u);
    assert.match(rowFor(run({ durationMs: undefined })), /\s\?\s/u);
  });

  it("keeps columns aligned when model ids differ wildly in length", () => {
    const lines = formatLedger([
      run({ stamp: "2026-07-27T07-49-13Z", model: "stub/burst-rehearsal" }),
      run({ stamp: "2026-07-28T06-37-03Z", model: "x" }),
    ]).split("\n");

    const commitColumn = (line) => line.indexOf("commit");
    assert.equal(lines[2].indexOf("79eb586"), lines[3].indexOf("79eb586"));
    assert.ok(commitColumn(lines[0]) > 0);
  });

  it("closes with the pass rate across every run", () => {
    const output = formatLedger([
      run({ stamp: "a", passed: true }),
      run({ stamp: "b", passed: false }),
      run({ stamp: "c", passed: false }),
    ]);
    assert.match(output, /3 run\(s\) · 1 passed · 2 failed$/u);
  });

  it("says so plainly when there is no history yet", () => {
    assert.match(formatLedger([]), /^No burst-run summaries/u);
  });

  it("renders a summary missing every optional field rather than throwing", () => {
    const line = rowFor({});
    assert.match(line, /\?/u);
    assert.match(line, /FAIL/u);
  });
});

describe("readSummaries", () => {
  it("reads the runner's summaries and ignores other tools' output", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "burst-ledger-"));
    await writeFile(
      path.join(directory, "feedback-burst-2026-07-28T06-37-03Z.json"),
      JSON.stringify(run({ stamp: "2026-07-28T06-37-03Z" })),
    );
    // jscpd writes here too, and it is not a burst run.
    await writeFile(
      path.join(directory, "jscpd-report.json"),
      JSON.stringify({ statistics: {} }),
    );
    await writeFile(
      path.join(directory, "feedback-burst-2026-07-28T06-37-03Z.html"),
      "<html></html>",
    );

    const runs = await readSummaries(directory);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].stamp, "2026-07-28T06-37-03Z");
  });

  it("takes the stamp from the filename when the artefact has none", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "burst-ledger-"));
    const summary = run({});
    delete summary.stamp;
    await writeFile(
      path.join(directory, "feedback-burst-2026-07-27T07-49-13Z.json"),
      JSON.stringify(summary),
    );

    const runs = await readSummaries(directory);
    assert.equal(runs[0].stamp, "2026-07-27T07-49-13Z");
  });

  it("skips a truncated summary instead of losing the rest of the history", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "burst-ledger-"));
    await writeFile(
      path.join(directory, "feedback-burst-2026-07-27T07-49-13Z.json"),
      '{"model":"stub/burst-rehearsal","conversa',
    );
    await writeFile(
      path.join(directory, "feedback-burst-2026-07-28T06-37-03Z.json"),
      JSON.stringify(run({ stamp: "2026-07-28T06-37-03Z" })),
    );

    const runs = await readSummaries(directory);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].stamp, "2026-07-28T06-37-03Z");
  });

  it("returns nothing at all when report/ does not exist yet", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "burst-ledger-"));
    assert.deepEqual(await readSummaries(path.join(directory, "absent")), []);
  });
});

/** The first data row, which is where every single-run assertion looks. */
function rowFor(summary) {
  return formatLedger([summary]).split("\n")[2];
}

function run(overrides) {
  return {
    event: "feedback_burst.finished",
    stamp: "2026-07-28T06-37-03Z",
    model: "openai/gpt-5.6-terra",
    commit: "79eb586c1d4f0a2b3e5d6c7a8b9e0f1a2b3c4d5e",
    dirty: false,
    passed: true,
    durationMs: 879_000,
    findings: [],
    conversations: [{ passed: true }],
    ...overrides,
  };
}
