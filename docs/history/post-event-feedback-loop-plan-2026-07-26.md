# Post-event feedback — conversation loop remediation plan

> **History. Delivered — do not build from this.** The 30 conversation-loop defects listed here were closed. Kept for the reasoning behind each fix, not as work to do.

Date: **2026-07-26**. Follow-up to
[`POST_EVENT_FEEDBACK_PLAN_2026-07-25.md`](post-event-feedback-plan-2026-07-25.md),
which this does not supersede: the architecture there stands, and everything
below is a correction to how the conversation loop behaves once real people are
typing into it.

## 1. Why this plan exists

A review of the turn loop started from one question — what happens when a
participant types in fragments instead of sentences — and ended up finding that
most of the loop's complexity exists to make **incremental extraction** safe,
and that several of its failure modes are invisible: they lose data without
raising anything an operator would see.

The organising insight is that the system analyses the conversation _while it is
still happening_. Every open defect below is a consequence of deciding too early
with too little of the conversation in hand. §7 proposes removing that
constraint entirely; §5 fixes the loop as it stands, and stands on its own if §7
is never done.

The second organising fact is the actual operating need, stated by the product
owner: **open the admin two or three times a day and see who is not answering
and why.** Latency does not matter — thirty seconds of delay is free. That
reorders everything: work that improves _visibility into non-response_ outranks
work that improves _extraction quality_.

## 2. What already landed (2026-07-26)

Three changes, all shipped with tests, typecheck and lint green:

| Change             | What                                                                                                                                                                                          | Where                                                                           |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Quiet window       | `feedback.extract.v1` is enqueued with a `FEEDBACK_EXTRACT_QUIET_WINDOW_MS` (12s) delay, so a typed burst collapses into one run instead of one run per fragment                              | `post-event-feedback.schemas.ts`, `post-event-feedback-materializer.service.ts` |
| Superseded reply   | Before inserting an outbox row the run re-reads the conversation; newer participant testimony drops the **ordinary** reply only. Completion and handoff copy always send                      | `post-event-feedback-extractor.service.ts`                                      |
| Provenance relaxed | An extraction must cite **at least one** message inside the current cursor window rather than _only_ messages inside it, so a thought typed across a window boundary is no longer thrown away | `post-event-feedback-extraction-validation.ts`                                  |

The third deserves emphasis: the old rule rejected an answer that honestly cited
both halves of a split thought, while accepting the same answer if it cited only
the second half. It punished accurate citation and silently lost testimony.

### 2b. The ledger sweep (2026-07-26, later)

The scenario suite's known-defect ledger went from **30 rows to 2**. Everything
below is landed with tests, both typechecks and Prettier green; nothing is
committed. Grouped by what it means for somebody on the other end of WhatsApp:

| What changed                                                                                                                                                                                             | Rows |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---: |
| **Nudges** — WP4 in full: silence-based ladder, two rungs, targeted wording, never into a flagged conversation                                                                                           |    4 |
| **A failed send reaches the conversation** instead of dying on an outbox row nobody opens                                                                                                                |    1 |
| **The decision to speak is re-taken** against reloaded state immediately before the outbox insert — the three "state changed during the model call" races were one fix                                   |    3 |
| **The bot stops when it must** — urgent safety and an explicit handoff set `awaitingHuman`; STOP matches after an answer and recognises a wrong number; an erasure request goes to a person              |    5 |
| **Testimony survives** — the transcript holds what it cannot send, an edited redelivery is its own turn, order follows the sender, a media message gets one apology, unmatched text is no longer deleted |    4 |
| **Resume picks up** testimony that arrived under human control                                                                                                                                           |    1 |
| **The right person** — Greeklish names resolve when exactly one candidate fits; talking about yourself is not a failed lookup                                                                            |    2 |
| **One reply per thought** — a run that comes due mid-burst stands down for the one behind it                                                                                                             |    2 |
| **Revision** — the newest reading of a question wins, moving somebody between lists moves them, and a refused score re-asks instead of confirming                                                        |    5 |
| **Prompt-owned** — erasure and reported speech; the scenario proves the system half, the live corpus proves the model half                                                                               |    2 |

Two remain, and neither is backend work: text from an **unmatched number** and a
message that arrives at a **full transcript** are both now kept and flagged, but
no screen shows them. They need an operator-facing surface for words that belong
to no conversation.

One database migration: `provider_message_ingress_unmatched_text_check` no
longer deletes the body of an unmatched row (D10 amended). The row still links
to no conversation, so nothing is attributed to a participant.

## 3. Findings, ranked

Each is verified against the code, not inferred. Severity is judged by _how much
data is lost_ and _whether anyone would notice_.

### F1 — Half-finished participants are never nudged 🔴

`listOpenDueForReminder` requires `remindedAt: null`, and `remindOne` skips any
conversation where `hasParticipantReply` is true. Together: a reminder goes
**only** to people who never replied at all, and **only once, ever**.

Somebody who answers question one enthusiastically and then stalls on question
two hears nothing again. They are the most valuable non-responders — they showed
willingness and we lost them mid-flow — and the system has no mechanism that
addresses them.

### F2 — Expiry measures from birth, not from silence 🔴

`listOpenDueForExpiry` filters on `createdAt <= olderThan`, and `expireOne` has
no last-activity guard. A participant who replied two minutes ago has their
conversation closed at the 72-hour mark, mid-question.

### F3 — Text is deleted when it arrives after closing 🔴

`findOpenByPhone` matches `lifecycle.state: "open"` only. A message arriving
after the conversation closed finds nothing, falls to `ignoreUnmatched`, and is
written with `text: null` — metadata kept, body destroyed.

This compounds with F2, and it is worst where it hurts most: the closing copy
says «Ό,τι άλλο θες να μας πεις, είμαστε εδώ», and disclosures are exactly the
kind of thing people say last, once they have warmed up.

### F4 — Media and reactions get silent treatment 🔴

Corrected after testing: an **emoji-only message has a text body** and flows
normally — «👍» lands in the transcript like any other message. Only **reactions
and true media** (photo, voice note) arrive with a null body.

Those reach `flagUnmaterializedInbound`, which raises `needsAttention`, marks the
ingress row failed, and sends **nothing**. From the participant's side the bot
simply stopped answering. In the admin they look like a non-responder while they
actually responded.

The distinction matters for WP2: a fix aimed at media must not swallow emoji into
the same path.

### F5 — A revised answer is discarded silently 🔴

Two layers refuse it. `validateAnswers` seeds its `seen` set from already-stored
answers keyed on `questionKey::subjectParticipantId`, so a corrected value is
rejected as `already_recorded`; `insertAnswerIfAbsent` then does
`onConflictDoNothing` on the same unique key. No update path for
`feedback_answers` exists anywhere in the repository.

The immutability was never a product decision. The unique key exists so a
**replay** cannot duplicate a row, and because the key has no time dimension it
cannot distinguish "the same run writing twice" from "the participant changed
their mind". The replay guard became a revision guard by accident.

A second shape of the same defect: moving a person between lists (`liked` →
`avoid`) writes the new row and leaves the old one, because the identities
differ. The participant ends up in both lists with nothing recording that they
changed their mind. That is worse than stale — it is contradictory.

### F6 — Delivery state does not reach the list view ⚠️

Delivery status is captured per outbox row and rendered per message inside the
transcript, but the campaign list projection carries none of it. From the inbox
you cannot separate:

| Observed          | Actual cause                           | Right response           |
| ----------------- | -------------------------------------- | ------------------------ |
| never delivered   | number wrong, blocked, phone off       | fix transport / data     |
| delivered, unread | bad timing or the message did not land | change send timing       |
| read, ignored     | no reason to answer                    | change copy or incentive |

Three unrelated problems that look identical, distinguishable today only by
opening every conversation one at a time. A campaign where half the intros never
delivered reads as an engagement problem and gets debugged in the wrong place
for a week.

### F7 — Slow typists still get one reply per fragment ⚠️

Worse than first written, and measured rather than reasoned: at 20–25 seconds
between fragments **no collapsing happens at all** — every message clears the
12-second window on its own. Five fragments, five replies. The answers are
correct; the conversation stutters.

Two mechanics worth stating plainly, because they bound what WP3 can achieve:

- the window is **leading-edge**, timed from the first message of a burst, so a
  burst that takes longer than the window to type splits no matter what value is
  chosen. 45s covers ordinary typing; someone composing for two minutes still
  splits. Only a rolling debounce removes this entirely, and it was rejected as
  not worth the job-removal race.
- collapse therefore depends on the **elapsed time of the burst**, not the number
  of messages in it.

### F8 — STOP does not match what people actually type 🔴🔴 ✅ fixed in WP0

The most serious finding, and the only one with a legal edge. Matching is
whole-string equality after a normalisation that deliberately does **not** strip
punctuation. Verified by execution, not inspection:

| typed                  | stops |
| ---------------------- | ----- |
| `ΣΤΟΠ`                 | ✅    |
| `ΣΤΟΠ!`                | ❌    |
| `stop.`                | ❌    |
| `STOP!!!`              | ❌    |
| `Στοπ ευχαριστώ`       | ❌    |
| `μη μου ξαναστείλετε`  | ❌    |
| `stop na mou stelnete` | ❌    |

Every miss falls through to the model as ordinary testimony. The opt-in stays
`true`, the conversation stays open, and the reminder sweep stays armed — the
person who asked to be left alone is messaged again 24 hours later.

### F9 — One stuck conversation deadlocks the next campaign launch 🔴 ✅ fixed in WP0

`expireOne` skips participants who are no longer opted in, so their conversation
never closes. It holds the partial unique index on `phoneAtLaunch` indefinitely.
The next campaign's `createFromLaunch` throws `FeedbackConversationPhoneConflictError`,
and the launch loop has **no try/catch** — so `launch()` fails partway through the
attendee list, leaving a campaign that is half-launched and cannot be completed.
Two participants sharing one phone reach the same dead end directly.

### F10 — Completion copy outranks a disclosure 🔴

When the message carrying a disclosure is also the one that makes the last goal
terminal, `resolveOutbound` picks the closing copy and the conversation closes.
Someone who has just described being grabbed receives «Τέλεια, ευχαριστούμε
πολύ! 🙌» and the door. The flag and the alert do fire, so the record is right —
what is wrong is the only part the participant experiences.

### F11 — Long messages are truncated silently at 4,096 characters 🔴

`boundObservedMessageText` applies WhatsApp's **send** limit to received text, at
both edges, with no flag and no record that anything was cut. The tail is where
people put the thing they worked up to saying.

### F12 — A flagged note summons nobody 🔴

D18 degradation works exactly as designed — an unresolvable or ambiguous name
never becomes a guessed id, and the note is kept subjectless with
`flaggedForReview: true`. Then nothing happens. `needsAttention` stays false, no
alert is raised, and the note waits for an operator who has no reason to look.

The safeguard that stops a sexual remark landing on an innocent participant's
profile is therefore invisible in practice: it works, and no one ever learns that
it fired.

### F13 — The bot confirms changes it did not make 🔴

Validation rejections are a `logger.warn` and nothing reconciles the reply
against what was actually written. So the model can answer «Το άλλαξα σε 2!»
while `insertAnswerIfAbsent` did nothing (F5). Measured: a participant who
corrects a score receives a reply about the old value **and** a reply confirming
the new one, while the stored value is neither.

This is the worst class in the list, because every other defect loses data
quietly and this one actively tells people something untrue.

### F14 — The operator alert is a log line 🔴

`FEEDBACK_OPERATOR_ALERT`'s only implementation writes a structured log event.
An `urgent_human_follow_up` self-harm signal at 02:00 produces a log entry and a
badge in an admin nobody is looking at.

### F15 — Smaller, confirmed ⚠️

- **Citation cap.** `FEEDBACK_EXTRACTION_MAX_SOURCE_MESSAGES = 10` is a hard Zod
  bound rather than a truncation, so an answer honestly citing twelve fragments
  fails schema validation, retries, and lands in the deterministic fallback —
  which files «Πιθανή προσβλητική/ευαίσθητη αναφορά» over a complaint about
  table placement. **Widening the quiet window increases exposure to this**, so
  WP3 cannot ship alone.
- **Greeklish.** The extraction prompt forbids treating a Latin transliteration
  as a Greek name, so directed answers from a Greeklish typist degrade to flagged
  subjectless notes: one of three answers survived in test. Greeklish is not
  mentioned anywhere in the repository.
- **A reassigned number** keeps receiving questions about a dinner the new owner
  never attended, with `optedIn: true` and no flag.
- **Resume strands testimony.** Anything said while a conversation was under human
  control is only ever extracted if the participant happens to speak again —
  `resumeBot` enqueues nothing.
- **No erasure path** exists in the module, and nothing flags that one was asked
  for.

## 4. What we deliberately keep

Not everything that constrains the model is worth removing, and it is worth
being explicit about which constraints earn their place:

- **STOP stays deterministic**, evaluated before any model call. It is an
  opt-out, not a judgement.
- **Subject resolution stays.** A directed answer or note is a claim about a
  real, named person that staff will read. If the model guesses the wrong
  Κώστας, a sexual remark lands on an innocent participant's profile. This does
  not limit richness; it prevents misattribution.
- **Provenance existence and actor checks stay.** Without them the model can
  attribute to a person something nobody said.
- **The model never sends, never changes consent, never bypasses the campaign
  gate.**

What does _not_ earn its place is the goal ladder, the extraction cursor as an
idempotency fence, and answer immutability — all three are scaffolding for
incremental extraction (§7).

## 5. Work packages

Ordered so that data loss stops first, the stated operating need is served
second, and the architecture is revisited last.

### WP0 — The two that cannot wait (F8, F9) — ✅ **landed 2026-07-26**

Neither was about conversation quality. One was an opt-out that did not work;
the other silently broke campaign launch.

**STOP matching.** Now folds punctuation before comparing and accepts three
shapes, in widening tolerance and narrowing confidence: the whole message is a
command; the whole message is a command plus politeness («Στοπ ευχαριστώ»); the
message _opens_ with an unambiguous plain-language opt-out («μη μου ξαναστείλετε
μηνύματα παρακαλώ», and the Greeklish forms). Still a deterministic list — an
opt-out that depends on a model is not an opt-out.

Left-anchoring is what holds the boundary. The intro copy itself ends «γράψε
ΣΤΟΠ.», so nothing may match a command found _inside_ a sentence; and «σταμάτα να
ρωτάς για τον Νίκο» is an objection to a question, not a request to be left
alone. Bare `σταματα` stays unmatched for the same reason, while the formal
`σταματηστε` — addressed to us — is a command.

**The phone deadlock.** Expiry no longer checks opt-in: it sends nothing, so
withholding it protected nobody while the row stayed open forever holding the
phone index. And `launch()` now catches the phone conflict per attendee, audits
who was skipped, and continues — a half-launched campaign that fails at the same
person on every retry is worse than one person missing.

**Effect on the ledger:** seven rows turned red and had their `defect` labels
cleared — five STOP forms, the Greeklish opt-out, and the stale opted-out
conversation. Two unit tests were added for the launch path, which the scenario
harness cannot reach.

### WP1 — Stop deleting post-closure text (F3)

Add a lookup for the most recent **closed** conversation on a phone. When an
inbound message matches one, keep the body, link `matchedConversationId`, mark
the ingress row with a distinct status (`post_closure`) and raise
`needsAttention` so it surfaces in the inbox.

Do **not** reopen the conversation — reopening would let a closed thread start
talking again and muddies STOP semantics. The message becomes a flagged record a
human acts on.

Retention follows decision **D-a** in §9: metadata only for `stopped`, full text
for `completed` and `expired`, attention in every case.

Size: small. Risk: low. D10 needs a note that "unmatched" means _unrelated
shared-session traffic_, not _post-closure traffic from a known participant_.

### WP2 — Answer what we cannot read (F4)

Two distinct defects that the first draft of this plan ran together. Testing
separated them:

- an **emoji-only message has a text body** and flows normally today — nothing to
  fix, and the fix for the other half must not swallow it into the media path;
- **reactions and true media** (photo, voice note) have a null body and reach the
  silent path.

For the second, replace the silent flag with one deterministic bot reply — copy
owned by the question set, not the model — saying we cannot read photos or voice
notes yet and asking for text. Once per conversation, guarded by a
conversation-scoped dedupe key, so eight photos get one reply. Keep the attention
flag. `FeedbackReceivedKind` needs a name for this copy.

Size: small. Risk: low.

### WP3 — Widen the quiet window, with the citation cap (F7, F15)

`FEEDBACK_EXTRACT_QUIET_WINDOW_MS` 12s → 45s. Latency is explicitly free, and a
wider window collapses more bursts, spends less and reads better.

**It cannot ship alone.** A wider window puts more fragments in one run, and the
citation cap is a hard schema bound that turns an honest twelve-message citation
into a retry storm ending in a safety-flavoured fallback note. Change the cap to
a truncation — keep the first ten cited ids, drop the rest — so an over-cited
answer is recorded rather than destroyed.

Size: one constant plus one schema change. Risk: low.

### WP3b — Make the safeguards visible (F12, F14)

Two cheap changes that turn work the system already does into something a human
finds out about:

- a note written with `flaggedForReview` raises `needsAttention`, so D18
  degradation surfaces instead of waiting to be stumbled on;
- the operator alert gets one real delivery channel. Anything a person actually
  receives — email to the on-call address is enough for MVP — beats a log line
  nobody tails at 02:00.

Size: small. Risk: low. Disproportionate value for the effort.

### WP4 — Silence-based lifecycle with targeted nudges (F1 + F2) — ✅ **landed 2026-07-26**

The largest win against the stated need, and half the architectural change in
§7 arrives with it.

1. ✅ **Measure from silence, not from birth.** Reminder and expiry both run off
   the participant's own newest message, falling back to launch when they never
   wrote. Our outbound deliberately does not reset it, or nudging somebody would
   postpone their expiry indefinitely. The Mongo queries still filter on
   `createdAt`: age is a correct superset of silence, so the coarse filter needs
   no denormalized field and the exact rung is decided on the loaded document.
2. ✅ **Allow several nudges.** `reminderCount` joins `remindedAt`, and
   `markReminded` advances it under a compare-and-set so two racing sweeps
   cannot double-nudge. The `hasParticipantReply` exclusion is gone. Nudge _N_
   falls due after _N_ × `FEEDBACK_REMINDER_AFTER_HOURS`, capped by the new
   `FEEDBACK_MAX_REMINDERS` (2), and the dedupe key carries the ordinal — a
   single per-conversation key was itself a reason the second nudge could never
   land.
3. ✅ **Make the nudge targeted** — but deterministically, not with a model. The
   reminder now restates the open goal's own `prompt`, taken from the campaign's
   launch snapshot, under new `reminder_followup` copy. Somebody who has answered
   nothing still gets the generic invitation. A model call was the plan's
   proposal and is not worth its failure mode here: the wording that matters is
   the question itself, which we already store verbatim, and the sweep stays free
   of provider latency, cost and retry non-determinism.
4. ✅ **Close on exhaustion** — via the same silence clock, at 72 hours. **The
   distinct `closedBecause` word was deliberately not added.** The scenario suite
   settled on `expired` for this path, and a fifth lifecycle reason ripples
   through the Mongo schema, the admin DTO, the generated client and the inbox
   labels for a distinction nobody has yet asked to filter on. Worth revisiting
   the first time somebody actually wants to tell the two apart.

**One rule the suite discovered that the plan had not:** a conversation with
`needsAttention` is never nudged. Enabling nudges for people who had replied
meant the ladder could now walk into a conversation where somebody had disclosed
self-harm or been promised a human — and ask them about the dinner a day later.
Two existing scenarios already declared `reminder: 0` as their desired outcome
and turned red the moment the exclusion was dropped, which is exactly what the
suite is for. Expiry is deliberately not held back the same way: it sends
nothing and releases the phone's unique index.

This makes closing fully deterministic — a counter and a clock — which removes
any need for the model to decide when a conversation is finished, and keeps
retries deterministic because a retry re-reads stored state rather than forming a
fresh opinion.

Landed in `post-event-feedback-sweep.service.ts`, `feedback-conversation.{schemas,repository}.ts`,
`post-event-feedback-question-set.ts` and `environment.ts`. No migration was
needed: `reminderCount` is defaulted, so documents written before the ladder
existed parse as "never nudged". Three scenarios cover it — the ladder, the
targeted wording and the attention guard — and the last two were each verified to
fail when their guard is removed.

### WP5 — Delivery state in the list view (F6)

Project the latest outbound's delivery status per conversation into the campaign
list response, and make it filterable in the admin inbox. The data exists; it
does not travel far enough.

Size: small-to-medium, backend join plus admin column. Risk: low. **This is the
one that changes the morning routine.**

### WP6 — Revisable answers (F5)

Only if §7 is rejected. Append-only with supersede: put a source-testimony
signature into the replay identity so a replay is still absorbed while a
revision from new testimony becomes a new row that supersedes the prior one.
Current value is the latest non-superseded row; history is retained.

Size: large — migration, read paths, admin. **Recommendation: do not build it.**
§7 makes it unnecessary, and building both would be waste.

## 6. Acceptance — the suite exists

Built the same day, and it is the gate for every work package here.

|                     |                                                                                                      |
| ------------------- | ---------------------------------------------------------------------------------------------------- |
| Scenarios           | **75**, table-driven, in five spec files over one shared harness                                     |
| Passing today       | 61 (was 41 this morning)                                                                             |
| Known-defect ledger | **21**, running under `it.fails` — thirteen cleared today                                            |
| Catalogue           | `docs/backend/modules/post-event-feedback-scenarios.md`                                              |
| Harness             | `post-event-feedback-loop.harness.ts` (a `*.harness.ts` suffix keeps it out of the production build) |

Each scenario is a kind of person, not a code path, and asserts two to four facts
about **where the conversation ended up** — what was recorded, what the
participant received, in what order, and what survived. It never asserts a job
id, a cursor, a goal status, or model-written wording. That is what lets §7
delete the goal ladder and the cursor without editing a single test.

**The ledger is the deliverable, not a workaround.** A row that names a defect
runs under `it.fails`: it passes while the bug exists and turns red the moment
somebody fixes it, which forces them to delete the `defect` line. Running the
suite prints the current list of people we serve badly. Every finding in §3 has
rows; fixing a work package means watching its rows go red and clearing them.

Two honest gaps:

- **The superseded-reply guard shipped in §2 is unreachable from the suite.**
  Steps are sequential and a model call completes inside one drain, so nothing
  can arrive between a run's snapshot and its outbox insert. It is covered only
  by the unit tests written alongside it. Closing this needs a harness hook that
  runs a step mid-`propose`.
- **Multi-conversation scenarios are not expressible** — the harness builds one
  conversation, so F9's downstream half (the next campaign failing to launch) is
  asserted at its cause rather than its effect.

## 7. The architectural question: extraction at rest

Recommended, but deliberately separated so §5 can ship without it.

**Today.** After every participant message the system runs a mini-analysis and
writes results immediately, accumulating the picture in pieces across dozens of
runs. That accumulation is the source of the cursor, the unique constraints, the
note content signatures, the immutability and the provenance windows. All of
them answer one question: _what did I already write before I died?_

**Proposed.** One job — read the whole transcript, rewrite the whole picture —
running whenever the conversation falls quiet. It replaces rather than appends,
so nothing needs remembering: it always reads everything, always writes
everything, and a retry re-runs it to the same result. The last time it runs
happens to be final; there is no separate "final pass" and no special case.

**Retry safety improves.** One write in one transaction has no halfway state.
A retry finds either nothing written or everything written. That is
strictly easier to get right than reconciling partial accumulation, so the
simplification is what _buys_ the safety rather than trading against it.

**What it deletes:** the goal ladder and `isCompleting`, the extraction cursor as
a fence, answer immutability and WP6 with it, `stale_source_message` as a concept
(every run sees the whole transcript, so nothing is ever stale), and the
fragmentation class of defects entirely.

**What it keeps:** everything in §4.

**Progress bars survive.** The same job produces the interim picture; because
nobody watches in real time, running it on the quiet-window timer is ample —
worst case the admin is a minute stale, against an operator who checks three
times a day. The interim picture must **replace itself wholesale**; if it
accumulates, today's system has been rebuilt with a second one on top, which is
the failure mode to watch for in review.

**Do not reconcile interim against final.** "What if they disagree" has no good
answer. The final pass wins unconditionally. Log the diff as a model-quality
signal, never as a decision rule.

**The honest cost.** If the pass fails permanently, nothing is recorded, where
today each turn has already written what it understood. The transcript is always
there and the pass re-runs, but the terminal-failure fallback must be serious
rather than decorative.

**Migration.** Rewriting a conversation's picture wholesale needs either
delete-and-insert inside one transaction or a run identifier on the rows with
reads scoped to the newest. The latter keeps history and is preferred.

## 8. Sequencing

| Order | WP                  | Why here                                                                                        |
| ----- | ------------------- | ----------------------------------------------------------------------------------------------- |
| 0     | **WP0**             | An opt-out that does not work, and a launch that breaks. Blocking before any real participant   |
| 1     | WP1, WP2, WP3, WP3b | Small and independent: stop losing data, stop the silent treatment, make the safeguards visible |
| 2     | ~~WP4~~ ✅ landed   | Largest win against the stated operating need, and half of §7 arrives with it                   |
| 3     | WP5                 | Changes the morning routine                                                                     |
| 4     | §7                  | Architectural; on its own branch, deliberately                                                  |
| —     | WP6                 | Only if §7 is rejected                                                                          |

F10, F11 and F13 are not yet in a work package. F13 (the bot confirming changes
it did not make) is the worst-behaved defect in §3 and is largely dissolved by
§7, since a single final pass has nothing to disagree with. F10 and F11 are small
and belong wherever the safety path is next opened. Their ledger rows are red
regardless, which is the point of having them.

## 9. Decisions taken (2026-07-26)

Both were delegated with the instruction "mildly conservative, but MVP".

### D-a — Post-closure text retention (WP1)

**Metadata only for a conversation closed by `stopped`. Full text for
`completed` and `expired`. Attention raised in every case.**

The deciding argument is asymmetry: _not_ storing is a reversible policy and
storing is not. If a month of operation shows we are losing something that
matters after an opt-out, the switch opens. The reverse cannot be undone. So the
legally sensitive branch keeps only "somebody who opted out wrote to you, look at
WhatsApp", while the two ordinary branches — which are the overwhelming majority
— keep everything.

### D-b — Nudge cadence (WP4)

**A reminder at 24 hours of silence, a second at 48, close at 72. Maximum two.**

Silence means time since the last participant message, falling back to the last
outbound where they never replied at all.

The numbers are deliberately **unchanged from today** — the current code already
uses 24 and 72, measured from conversation creation rather than from silence. So
the correction moves the _measurement point_, not the cadence: no surprise for
anyone receiving messages, and the half-finished participant finally gets a
nudge. A participant who never answers receives three messages in total (intro
plus two reminders), which is the ceiling before WhatsApp outreach starts reading
as spam.

`FEEDBACK_REMINDER_AFTER_HOURS` and `FEEDBACK_EXPIRE_AFTER_HOURS` keep their
values and gain the corrected meaning; `FEEDBACK_MAX_REMINDERS` (default 2) is
added.

## 10. Still open

1. Whether live progress bars are worth an interim model call per quiet period,
   or whether a picture computed only at close is enough (§7).
2. Whether `avoid` and free-form remarks about named people need a different
   visibility or retention rule from ordinary feedback, given they are directed
   claims about real participants that staff read.
