# Post-event feedback: what is still open, 2026-07-29

> **Evidence. What was open on 2026-07-29.** An observation fixed to its date,
> not a work list. Items here may since have been closed; the code and its tests
> are the live statement.

Date: 2026-07-29

What was known to be wrong, unproven or undecided in the post-event feedback
loop on the day work on it stopped. An observation fixed to its date, not a
plan: nothing here is assigned, estimated or promised.

## How this list was produced, and what its shortness means

Every defect fixed in this module was found by **reading transcripts** of paid
rehearsals against `openai/gpt-5.6-terra` — not by a failing test and not by the
rehearsal's own verdict. That matters for reading the list below.

Across eleven recovered runs, **every individual conversation passed** and every
`FAIL` was a cross-cutting finding, usually `campaign_not_terminal` held open by
a persona whose own fixture calls itself an observation. Paid mode treats
per-persona semantic expectations as observations by design, so a conversation
cannot fail on one. The automated verdict therefore rests on settlement and job
failures and nothing else, and **a green paid run is a weak claim.**

So a short list of open defects means the transcript reading has been exhausted,
**not that the code is clean.** The next real finding comes from new material — a
run against a different model, a larger corpus, or the first real participants —
rather than from further inspection of what is already written down.

## Open, with evidence

### Somebody's question about their own data reaches nobody

Λούλα Γκροκούλα asked four times, in one conversation, what happens to what she
tells us. She was answered four times with near-identical sentences, the fourth
opening «Χαχα, δίκιο, το έκανα λίγο copy-paste 😄» — the bot naming its own
repetition, which is a rule 11δ violation the joke does not excuse.

The heavier half is that **the question left no trace.** Six notes recorded
everything about her evening and none says she asked. There is no attention
reason that names it either, so nothing about «this person asked us something we
would not answer» reaches an operator.

The cheap half of the fix — vary the wording, and record the question as a note —
needs no product decision. The rest depends on the next item.

### Nobody has decided what the bot may say about data handling

Rule 11στ forbids the model from saying anything at all about storage, readers,
retention, anonymity or effect on seating. It is the longest rule in the prompt,
about a thousand characters, and every one of them describes a hole.

[The draft answers](../backend/modules/post-event-feedback-policy-answers.md)
propose eleven questions with wording for eight of them. **None is approved.**
Two findings surfaced while writing it and stand on their own:

- The `avoid` question already ends with **«Μένει αυστηρά μεταξύ μας»** in the
  launch copy every campaign sends. Confidentiality about who somebody wants to
  avoid is therefore promised in production today, and 11στ stops the bot
  confirming it when asked. Whatever is decided has to at least match the promise
  that already reached people.
- **The prompt has no rule about the bot's own identity.** The real-model corpus
  grades it from both sides — `disclose_bot_identity` required,
  `claim_human_identity` forbidden — so a model claiming to be human fails the
  eval, while nothing in the instructions tells it not to. It has behaved
  correctly on its own so far.

Retention and anonymity are marked in that file as needing a decision outside
engineering. A wrong answer there is worse than the current deferral.

### Faint praise is not graded

«σου έκανε ιδιαίτερα καλή εντύπωση» answered with «πέρασε» or «ήταν οκ» is not a
`liked` answer, and the model was right to refuse it. Two fixtures said otherwise
and **three paid runs were spent chasing a defect that was in the test.** The
fixtures were corrected in `395b957`; what does not exist is a real-model corpus
case pinning the judgement, so nothing would catch a model that starts banking
tepid praise as praise.

### A long message between two limits cannot be stored at all

Found by inspection on the last day, not by a run, and unfixed.

The webhook edge bounds inbound text at `FEEDBACK_OBSERVED_TEXT_HARD_LIMIT =
64_000` (`apps/backend/src/modules/post-event-feedback/jobs.schemas.ts`). The
column it is written to caps at 10,000:
`provider_message_ingress_text_length_check` in
`packages/database/drizzle/20260725181557_post_event_feedback_persistence.sql`
allows `char_length(text) between 1 and 10000`.

So a message of 10,001–64,000 characters passes validation and **fails the
insert**. Nobody has sent one — the longest rehearsal fixture is a few thousand
characters — which is why no run has caught it.

It matters more than its rarity suggests. The 64,000 limit was chosen
deliberately, with a comment saying so, because a shared 4096 value had already
cut an inbound message at the edge and «people write their way up to the hard
thing, so the tail is where a disclosure lives». The essay-length disclosure is
exactly the shape that would hit this, and it would fail at the database rather
than degrade.

Whoever picks this up: decide which limit is the real one and make the other
agree with it. Do not simply raise the column — 64,000 characters of WhatsApp
text is worth a conscious decision about retention.

## Known limits that are not defects

Written down because each looks like a bug to somebody meeting it cold.

- **A paid run's `PASS`/`FAIL` is close to meaningless.** See above. The value is
  in the rows and the transcripts; the four `pnpm feedback:burst:*` commands
  exist because of that.
- **An abusive `avoid` is only held when the abuse and the answer share a
  message.** Abuse arriving in a later burst than the answer it explains leaves
  the earlier row unheld. Widening it to «every answer in the conversation» would
  hold answers about people the abuse had nothing to do with.
- **A withdrawal leaves the conversation open, a refusal closes it.** The bot
  giving up and the participant refusing are different endings on purpose:
  `declined` for the second, open plus a badge for the first.
- **`urgent_human_follow_up` makes the bot say nothing at all.** That is
  deliberate for a self-harm disclosure and is why `abuse_of_a_participant` is
  capped below it.

## What run 10 found

The last paid run, `2026-07-29T08-40-24Z`, against `openai/gpt-5.6-terra`: 36
conversations, 9m35s, `matched=66 missing=4 extra=0`, every individual
conversation `passed`, and the run itself `FAIL` on two `campaign_not_terminal`
findings — the usual shape, and the usual reason to distrust that verdict.

**The summary records `dirty: true`, and that is a procedural failure of ours.**
No source file differed from `c6467a6`; what was dirty was this file and the
evidence index, written while the run was in flight. The runbook says commit
first for exactly this reason, and the flag cannot tell documentation from code.
Treat the run as informative and not as a reproducible baseline.

### An abusive conversation was recorded as a polite refusal

Μπάμπης Διπλογαμωσταυρίδης swore at the bot twice, then wrote «δε σου απανταω
τιποτα, ασχετε». The classifier read that third turn as dismissive rather than
abusive, so the hostility counter stalled at **two**, the exit line — which needs
more than three — never fired, the model wrote its own goodbye and skipped every
goal, and the conversation **closed as `declined`**.

His fixture declares `lifecycle: open`, `closedBecause: null`. Paid mode grades
that as an observation, so the run reported this conversation as **passed**.

Two separate things are wrong and they should not be conflated:

- **The ladder depends on every rude turn being classified hostile.** One turn
  read as merely dismissive stalls a counter that never falls, and the freeze
  that is supposed to protect an operator from an abusive thread never happens.
  This predates the `declined` work — before it, the same path wrote `completed`,
  which was worse.
- **`declined` now describes him.** The word was introduced for Πάνος Μούλαρος,
  who refused civilly, and its whole point was to distinguish him from Μπάμπης.
  Where the ladder stalls, the two become the same row again. The attention
  reason an operator gets is `post_closure_message` — «somebody wrote after this
  closed» — rather than `hostile_to_bot`, so the badge does not say what happened
  either.

### A disclosure arrived after the bot had already stopped

Νίτσα Κομποσερογιάννη, live guest. The half that was fixed held: she opened with
«θα σας πω και κάτι ακόμα, αλλά πρώτα θέλω να σας ρωτήσω: αυτά τα feedback πού
πάνε;» and the reply carried **no** safety assurance — an announcement is no
longer treated as something we have forwarded.

Then she asked again whether a human reads it, and the model answered with the
**handoff** copy: «Κάποιος από την ομάδα μας θα επικοινωνήσει μαζί σου
προσωπικά.» Rule 10 says a question is not a request for a human, and 11στ says
in as many words not to set `handoff=true` merely for this. The handoff set
`awaitingHuman`.

She then described the incident — Τάκης insisting on driving her home after she
said no twice — and closed with «please επιβεβαιώστε μου ότι το λάβατε». She
received **nothing**, because the bot had already stopped talking.

The silence after a handoff is by design; the handoff was not. So the same shape
as the defect fixed this morning — a promise landing on the announcement and
silence on the disclosure — reached her through a different door. Her words were
recorded and the conversation carries both `safety` and `handoff`, so nothing was
lost and an operator sees it. What she asked for, and did not get, was
confirmation that it arrived.

### One thing was better than expected

Λούλα Γκροκούλα asked four times what happens to her answers, twice naming the
repetition herself («πετάχτηκες λίγο από την ερώτησή μου», «ξαναείπες το ίδιο»),
and the conversation closed with her question unanswered. But this time the model
**recorded it as a note** — «Ρωτά αν όντως διαβάζει κανείς όσα γράφει ή αν απλώς
συλλέγονται απαντήσεις». So the «reaches nobody» half of that defect is
intermittent rather than systematic, which is worth knowing before anybody builds
a mechanism for it.

## Not proven on a live table

Three product changes landed on 2026-07-29 and are pinned by deterministic
scenarios only.

- **The safety assurance now waits for the incident** rather than firing on the
  announcement of one, and its dedupe is read off the transcript rather than
  borrowed from `needsAttention`. Run 10 exercised this against a live guest and
  the announcement correctly earned no assurance — one observation, not a proof,
  and the classifier's `incidentDescribed` is a model judgement no deterministic
  test can check.
- **A refused questionnaire closes as `declined`** with one quiet acknowledgment
  instead of silence. Confirmed live for Πάνος Μούλαρος; see above for the case
  where the word lands on the wrong person.
- **The admin shows parked conversations** during a provider outage, and delivery
  state moved from a chip stack into the message's own meta line. Verified by
  hand against run 9's data with the states forced and then restored; no run has
  produced a real outage since.

## Where to look first

`docs/backend/modules/post-event-feedback.md` for the mechanism,
`…-scenarios.md` for the behavioural catalogue with a `Today` line per row, and
`…-rehearsal-history.md` for what the sixteen paid runs can and cannot be used to
argue. The last of those is the one that saves money.
