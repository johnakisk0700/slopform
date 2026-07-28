# Post-event feedback: rehearsal history

Every paid multi-campaign rehearsal that has been run, and — more importantly —
what these numbers can and cannot be used to argue.

Runs from 2026-07-28 onward record themselves: the runner writes
`report/feedback-burst-<stamp>.json` beside its HTML report, that JSON is
tracked, and `pnpm feedback:burst:ledger` prints one line per run from those
files. **Do not extend the table below by hand for future runs** — it is a
record of what happened before the artefacts existed, not a register anybody
maintains.

Eleven of the sixteen runs were recovered afterwards, from the `finished` event
each had printed to its own stdout, and back-filled as summaries. They carry no
commit, which is why the generated ledger shows `?` in its `commit` and `tree`
columns for them. **The other five left nothing recoverable at all**, so for
those the table below is the only record that they happened.

## The sixteen runs before the ledger

Reconstructed from the reports in `report/`, not from anybody's memory.

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

"Rows held / not" counts expectation rows, not conversations. In **stub** mode
those rows are assertions and a failure is a defect. In **paid** mode they are
deliberately observations — semantic expectations do not fail a paid run, only
the cross-cutting correctness checks do — so a paid row that did not hold is a
thing to read, not a thing that is broken. The two columns are therefore not the
same measurement in the first line as in the rest.

## What this table cannot be used to argue

**Nothing about which model is better.** Not one of these sixteen runs recorded
the commit it measured, and the tree was changing all day: prompt rules, the
attention classifier, the validation boundary, the fixtures themselves. Two runs
with different numbers may differ because of the model, the prompt, a corrected
expectation, or a persona that did not exist yet, and the artefacts cannot tell
those apart. Comparing `gpt-5.6-luna` at 136/2 against `gpt-5.6-terra` at 220/6
compares eighteen conversations to thirty-six on two different codebases.

Three specific traps are visible in the table itself:

- **The counts scale with the corpus.** 18 → 24 → 30 → 32 → 36 conversations, so
  the denominator moves. Raw pass counts across a persona-count change mean
  nothing; even ratios are shaky, because each new dinner brought new hazards
  rather than more of the same ones.
- **The same model and the same corpus still moved.** Four consecutive
  twenty-four-conversation `terra` runs went 174/0, 169/6, 162/12, 164/10 —
  monotonically _worse_ while the work was going well. The cause was us: new
  expectations were being written and some of them were wrong. A run that gets
  worse is not evidence the model got worse.
- **Duration is not throughput.** The jump from ~24 minutes to ~9 with no change
  in size is a settlement rule and an early-stall exit, not the provider. The
  14m34s and 12m16s at the end are the live-guest table, which waits on a local
  CLI between turns.

## What the automated verdict is actually worth

Generating the ledger surfaced something the HTML never made obvious. Across all
eleven recovered runs, **every individual conversation passed**, and every single
`FAIL` verdict came from a cross-cutting finding — `campaign_not_terminal` alone
accounts for eight of the eleven.

That is not a bug, it is the paid-mode design working as documented: semantic
expectations are observations there, so a conversation cannot fail on one. But it
means the automated verdict of a paid run rests on settlement and job failures
and nothing else, and settlement is frequently held open by
`ouzeri_contradicts_within_one_message`, a persona whose own fixture comment
declares it «an observation, not yet a contract». So a paid run currently reports
`FAIL` mostly for a case we already agreed not to hold anybody to.

Two consequences worth keeping in mind. A green paid run is a weak claim, and a
red one usually is too — the value is in the rows and the transcripts, which is
why the four inspection commands exist and why every defect in the list below was
found by reading rather than by a verdict. And if the verdict is to mean more
than that, the fixtures that are deliberately open have to stop being counted in
it, rather than the bar being lowered until they pass.

## What it is good for

Each run is a source of transcripts, and the transcripts are where every defect
worth fixing came from. The fixes are in the git history with the evidence quoted
in the commit message; this table is how you find which run to open. Some of what
those runs produced:

- A model that read four plain answers, extracted nothing, and asked for a human
  — a `handoff` the application obeyed without checking, twice.
- A reply that translated a participant's racism into «δεν σου ταίριαξε η παρέα»
  and raised no flag at all.
- Thirty-six provider errors turned into thirty-six inbox rows each demanding a
  human, and thirty-six people told the analysis of their evening had failed.
- Five answers missing in the same places across three consecutive runs, two of
  which turned out to be fixtures answering «σου έκανε ιδιαίτερα καλή εντύπωση»
  with «πέρασε» and then demanding the strong reading. The model was right; the
  corpus was measuring its own wording.

That last one is the reason this page exists. Three paid runs were spent chasing
a defect that was in the test, and a reproducible failure is exactly the kind
that looks most like a real one.

## How to make a comparison that holds

1. Freeze the tree. Commit everything, and record the sha — the JSON summary now
   does this, including whether the working tree was dirty. A dirty tree makes a
   run uncomparable, so treat that flag as disqualifying rather than as a note.
2. Change one thing. The model, or the prompt, or the fixtures. Not two.
3. Run each side **two or three times**. The live-guest table is improvised and
   the provider is not deterministic, so a single run cannot separate a real
   difference from a mood.
4. Compare the JSON, not the impression. `pnpm feedback:burst:ledger` for the
   shape of each run and `pnpm feedback:burst:answers` for what was recorded
   against what each fixture declared. Do not compare the `PASS`/`FAIL` column;
   read the rows.

Until that has been done, the honest statement about model choice is that
`openai/gpt-5.6-terra` is what the rehearsal has been run against most recently
and that no comparison against `openai/gpt-5.6-luna` has been made under
conditions that would support one.
