/**
 * Specs for the tracked half of a rehearsal's output.
 *
 * `node:test` rather than vitest, for the reason given at the top of
 * `scripts/burst-report.spec.mjs`.
 *
 * These exist because the code they cover is the *last* thing a paid run does.
 * A run reaches it after half an hour and real provider spend, so the failure
 * modes worth pinning down here are the ones that would only ever be discovered
 * then: a run with no campaigns, a repository git cannot be read from, and the
 * round trip that the ledger depends on.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  buildFinishedEvent,
  readGitRevision,
  writeRunSummary,
} from "./burst-artefacts.mjs";
import { formatLedger, readSummaries } from "./burst-ledger.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

describe("buildFinishedEvent", () => {
  it("carries the revision the run happened on", () => {
    const event = buildFinishedEvent({
      result: result(),
      stamp: "2026-07-28T06-37-03Z",
      reportPath: "report/feedback-burst-2026-07-28T06-37-03Z.html",
      revision: { commit: "79eb586", dirty: true },
    });

    assert.equal(event.event, "feedback_burst.finished");
    assert.equal(event.commit, "79eb586");
    assert.equal(event.dirty, true);
    assert.equal(event.stamp, "2026-07-28T06-37-03Z");
  });

  it("preserves the exact named paid treatment beside model controls", () => {
    const event = buildFinishedEvent({
      result: result({
        model: "openai/gpt-5.6-luna",
        treatment: "prova",
        config: {
          reasoningEffort: "xhigh",
          attentionReasoningEffort: "high",
          serviceTier: null,
        },
        liveGuests: {
          mode: "deterministic_silence",
          total: 6,
          substituted: 6,
        },
      }),
      stamp: "s",
      reportPath: "report/feedback-burst-s.html",
      revision: { commit: null, dirty: null },
    });

    assert.equal(event.treatment, "prova");
    assert.deepEqual(event.config, {
      reasoningEffort: "xhigh",
      attentionReasoningEffort: "high",
      serviceTier: null,
    });
    assert.deepEqual(event.liveGuests, {
      mode: "deterministic_silence",
      total: 6,
      substituted: 6,
    });
  });

  it("keeps the report path relative so a run is not stamped with a laptop", () => {
    const event = buildFinishedEvent({
      result: result(),
      stamp: "s",
      reportPath: "report/feedback-burst-s.html",
      revision: { commit: null, dirty: null },
    });
    assert.ok(!path.isAbsolute(event.reportPath));
  });

  it("flattens every campaign's conversations into one list", () => {
    const event = buildFinishedEvent({
      result: result({
        campaigns: [
          { conversations: [conversation({ personaId: "a" })] },
          {
            conversations: [
              conversation({ personaId: "b" }),
              conversation({ personaId: "c", passed: false }),
            ],
          },
        ],
      }),
      stamp: "s",
      reportPath: "report/feedback-burst-s.html",
      revision: { commit: null, dirty: null },
    });

    assert.deepEqual(
      event.conversations.map((row) => row.personaId),
      ["a", "b", "c"],
    );
    assert.equal(event.conversations[2].passed, false);
    assert.equal(event.conversations[0].lifecycle, "closed");
    assert.equal(event.conversations[0].closedBecause, "completed");
  });

  it("survives a run that produced no campaigns at all", () => {
    // A run that fails before it seeds anything still has to write its artefact,
    // because "this model produced nothing" is a result worth keeping.
    const event = buildFinishedEvent({
      result: result({ campaigns: undefined, passed: false }),
      stamp: "s",
      reportPath: "report/feedback-burst-s.html",
      revision: { commit: null, dirty: null },
    });
    assert.deepEqual(event.conversations, []);
  });
});

describe("readGitRevision", () => {
  it("reads this repository's own head", async () => {
    const revision = await readGitRevision(repositoryRoot);
    assert.match(revision.commit, /^[0-9a-f]{40}$/u);
    assert.equal(typeof revision.dirty, "boolean");
  });

  it("reports unknown rather than throwing outside a repository", async () => {
    // The whole point of the null pair: a finished run must not fail here.
    const outside = await mkdtemp(path.join(tmpdir(), "burst-not-a-repo-"));
    const revision = await readGitRevision(outside);
    assert.deepEqual(revision, { commit: null, dirty: null });
  });
});

describe("writeRunSummary", () => {
  it("writes a summary the ledger can read back", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "burst-artefacts-"));
    const event = buildFinishedEvent({
      result: result({ durationMs: 879_000, model: "openai/gpt-5.6-terra" }),
      stamp: "2026-07-28T06-37-03Z",
      reportPath: "report/feedback-burst-2026-07-28T06-37-03Z.html",
      revision: await readGitRevision(repositoryRoot),
    });

    const written = await writeRunSummary({
      directory,
      stamp: "2026-07-28T06-37-03Z",
      event,
    });
    assert.equal(
      path.basename(written),
      "feedback-burst-2026-07-28T06-37-03Z.json",
    );

    // Pretty-printed and newline-terminated, because this file is committed and
    // has to diff like a file rather than like one enormous line.
    const raw = await readFile(written, "utf8");
    assert.ok(raw.startsWith("{\n"));
    assert.ok(raw.endsWith("}\n"));

    const runs = await readSummaries(directory);
    assert.equal(runs.length, 1);
    const line = formatLedger(runs).split("\n")[2];
    assert.match(line, /^2026-07-28T06-37-03Z\s+openai\/gpt-5\.6-terra/u);
    assert.match(line, /\s14m39s\s/u);
  });
});

function result(overrides = {}) {
  return {
    startedAt: "2026-07-28T06-22-24Z",
    finishedAt: "2026-07-28T06-37-03Z",
    durationMs: 879_000,
    model: "openai/gpt-5.6-terra",
    passed: true,
    campaigns: [{ conversations: [conversation()] }],
    findings: [],
    ...overrides,
  };
}

function conversation(overrides = {}) {
  return {
    personaId: "taverna_slow_typist",
    displayName: "Κώστας Αργοπληκτρολογάκιας",
    passed: true,
    actual: { lifecycle: "closed", closedBecause: "completed" },
    ...overrides,
  };
}
