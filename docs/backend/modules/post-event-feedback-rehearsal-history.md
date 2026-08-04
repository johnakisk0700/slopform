# Post-event feedback: rehearsal history

**Historical record — not an operating runbook.** Do not treat model names,
pass rates or durations below as current quality claims or as instructions to
change production config. For how rehearsals work today, see the
[post-event feedback module](post-event-feedback.md) and
[scenarios](post-event-feedback-scenarios.md).

From 2026-07-29 onward, runs write `report/feedback-burst-<stamp>.json` beside
the HTML report; `pnpm feedback:burst:ledger` prints one line per run from those
files. **Do not extend the table below by hand** — it records what happened
before those artefacts existed.

Eleven of sixteen pre-ledger runs were recovered from stdout `finished` lines
and back-filled as summaries (no commit → ledger shows `?` for `commit`/`tree`).
Five left nothing recoverable; for those, this table is the only evidence they
ran.

## The sixteen runs before the ledger

Reconstructed from `report/`, not memory.

| Stamp (UTC)      | Model                  | Conversations | Rows held / not | Duration |
| ---------------- | ---------------------- | ------------- | --------------- | -------- |
| 2026-07-27T07:49 | stub                   | 18            | 114 / 0         | 5m29s    |
| 2026-07-27T08:12 | `qwen/qwen3.7-max`     | 18            | 79 / 36         | 7m18s    |
| 2026-07-27T08:57 | `qwen/qwen3.7-max`     | 18            | 93 / 47         | 22m42s   |
| 2026-07-27T12:01 | `openai/gpt-5.6-luna`  | 18            | 126 / 13        | 22m39s   |
| 2026-07-27T13:00 | `openai/gpt-5.6-luna`  | 18            | 125 / 14        | 22m41s   |
| 2026-07-27T13:48 | `openai/gpt-5.6-luna`  | 18            | 132 / 7         | 8m34s    |
| 2026-07-27T14:11 | `openai/gpt-5.6-luna`  | 18            | 136 / 2         | 8m32s    |
| 2026-07-27T17:47 | `openai/gpt-5.6-terra` | 24            | 174 / 0         | 24m52s   |
| 2026-07-27T18:30 | `openai/gpt-5.6-terra` | 24            | 169 / 6         | 26m39s   |
| 2026-07-27T19:03 | `openai/gpt-5.6-terra` | 24            | 169 / 6         | 9m03s    |
| 2026-07-27T19:26 | `openai/gpt-5.6-terra` | 24            | 162 / 12        | 9m05s    |
| 2026-07-27T19:47 | `openai/gpt-5.6-terra` | 24            | 164 / 10        | 9m04s    |
| 2026-07-27T21:18 | `openai/gpt-5.6-terra` | 30            | 206 / 14        | 9m15s    |
| 2026-07-27T23:18 | `openai/gpt-5.6-terra` | 30            | 205 / 15        | 9m22s    |
| 2026-07-27T23:54 | `openai/gpt-5.6-terra` | 32            | 209 / 23        | 14m34s   |
| 2026-07-28T06:37 | `openai/gpt-5.6-terra` | 36            | 220 / 6         | 12m16s   |

"Rows held / not" counts expectation rows. In **stub** mode failures are
defects; in **paid** mode semantic expectations are observations (only
cross-cutting correctness fails the run) — so the two columns are not the same
measurement as the stub line.

## What this table cannot argue

**Nothing about which model is better.** None of these sixteen recorded the
commit measured, and the tree changed all day (prompt, classifier, validation,
fixtures). Different numbers may differ by model, prompt, expectation or
persona; artefacts cannot tell them apart.

Visible traps:

- Counts scale with corpus size (18 → 36); raw pass counts across persona-count
  changes mean nothing.
- Same model + same corpus still moved when expectations were rewritten (four
  consecutive 24-conversation `terra` runs got worse while the work was fine).
- Duration is not throughput (settlement rules, early-stall exit, live-guest
  waits).

Across eleven recovered runs, every conversation passed; every `FAIL` was a
cross-cutting finding (`campaign_not_terminal` for seven of eight). Paid-mode
design: semantic expectations cannot fail a conversation, so the automated
verdict rested on settlement/job failures — often held open by fixtures later
repaired (e.g. `ouzeri_contradicts_within_one_message` on 2026-07-31). A green
or red paid run is a weak claim; value is in rows and transcripts.

## What it is good for

Each run is a transcript source. Fixes landed in git with evidence quoted in
commit messages; this table finds which run to open. Defects found by reading
included: empty extraction + obeyed handoff; racism paraphrased with no flag;
provider errors exploded into inbox rows; fixtures that demanded a strong
reading of a weak answer (model right, corpus wrong).

## How to make a comparison that holds

1. Freeze the tree; record the sha (JSON summary includes dirty-tree flag —
   dirty → uncomparable).
2. Change one variable (model **or** prompt **or** fixtures).
3. Run each side two or three times (live-guest + provider noise).
4. Compare JSON (`pnpm feedback:burst:ledger`, `pnpm feedback:burst:answers`) —
   not the `PASS`/`FAIL` column.

Current `prova` profile and model routing are owned by the feedback module /
scenario harness config — not by this page. Until repeated clean runs change one
variable at a time, no controlled quality claim is supported from the table
above.
