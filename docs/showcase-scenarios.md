# Event feedback showcase and test scenarios

Checkpoint: **2026-09-08**. Product direction and synthetic fixture authoring,
not an implemented workshop questionnaire or measured response rate.
See [the portfolio plan](portfolio-plan.md) for current implementation scope.

## Fixture authoring implementation

The [workshop fixture package](../fixtures/workshop-feedback/README.md) owns the
event brief, 55 reusable character archetypes, 100 participant profiles, the Luna
generation prompt and ten dialogue batches. Two native Astra agents authored and
cross-checked event facts and profiles. Native Luna agents use xhigh; root reviews
the first ten conversations as a pilot before accepting further batches.

`pnpm workshop:build-fixtures` projects the source dialogues into deterministic
JSON message records matching the existing PostgreSQL stored-message schema.
Expected findings remain in a separate artifact with source references.
`pnpm test:workshop-scenarios` checks the corpus and generated-file drift; it runs
inside `pnpm check` and makes no provider or database calls. Turbo owns the
backend build dependency and generated artifact outputs.

These are seed-source artifacts, with `runtimeImportReady: false`. No imported
campaign, successful extraction, delivery evidence or finished analysis is
claimed. The approved workshop questionnaire and an isolated replay/seed adapter
are still required before runtime ingestion. Author-drafted expectations need
semantic review and actual extraction comparison; the scenario task remains in
progress until those later acceptance criteria are met.

## One showcase story

Use a fictional **workshop with 100 invited attendees**, selected by the user.
The concrete working subject is hands-on smartphone photography, proposed for
this scenario: short demonstrations followed by practice in smaller groups.
One coherent story is enough; a second business vertical is optional.

The organizer wants to know what people learned and what to fix before the next
workshop. The demo follows a participant's short feedback conversation, the
captured evidence, a completed campaign's analysis, and a research question.
The organizer can inspect original comments and correct a mistaken extraction.
An optional two-minute browser voice interaction uses the same event and role.

Example: “την έκθεση την κατάλαβα επιτέλους, αλλά στην άσκηση με το φως μας
τρέξανε λίγο”. A useful bot clarification asks which part needed more time if
that is unknown, without suggesting an answer. Preserve both the learning gain
and the criticism. A useful research question is “Πόσοι διαφορετικοί συμμετέχοντες
ήθελαν περισσότερο χρόνο εξάσκησης, σε ποιες ασκήσεις και ποια σχόλια το
στηρίζουν;” Exercise-specific conclusions require corresponding evidence.

The planned standalone **Campaign analysis** view replaces the old six-person
summary experience. Show themes, distinct respondent counts, supporting excerpts,
outliers and explicit incomplete coverage. Optional AI conclusions use those
findings. Remove the old gossip-oriented product framing in that rewrite.
The existing summary remains operational until replacement is implemented.

## What exists and what still needs implementation

- Existing: conversation/extraction infrastructure, human review, research chat,
  and a bounded topic-analysis backend with PostgreSQL snapshots and embeddings.
- Existing topic analysis reads active extracted notes, not every answer or raw
  transcript. A populated corpus must exercise extraction before clustering.
- Missing: event-appropriate questionnaire, standalone analysis view, replacement
  summary contract, research-tool access to the new results, and voice integration.
- The current V2 questionnaire includes table fit, conversation participation,
  meet-again and avoid. Do not relabel those fields as sound, organization or
  future-event attendance. Specify a versioned event questionnaire and its
  extraction contract before claiming the workshop conversation runs end to end.

Candidate interview: brief overall experience; one useful open follow-up about
what worked or should improve; clarification only for missing relevant context.
Whether an explicit overall rating is collected remains part of questionnaire
design. No requirement to ask everyone about every possible topic.

## Create test scenarios

Deliver one clearly labeled synthetic campaign with reusable conversations and
separate reviewed expected findings. It tests extraction first and then supplies
real extracted notes to topic analysis. Do not seed expected notes directly and
call that a successful extraction test.

### Design the participants before generating prose

Start with a shared event brief: practice groups, schedule, exercises and possible
differences in experience. Assign each fictional participant their own location,
attendance duration, observations, opinions, writing style and willingness to
answer. A participant does not know the organizer's entire event brief.

Proposed coverage allocation, deliberately synthetic rather than a forecast:

| Conversation outcome                                   | Attendees |
| ------------------------------------------------------ | --------- |
| Complete short feedback                                | 55        |
| Partial response, interruption or unanswered follow-up | 30        |
| Explicit decline / STOP                                | 5         |
| No response                                            | 10        |

Distribute Greek, Greeklish and mixed-language writing across outcomes and
experiences. Include praise, mixed opinions, unclear instructions, pacing,
practice time, access to tutor help, a few rare concerns and irrelevant remarks.
These are authoring coverage
targets, not categories given to clustering or a fixed product taxonomy.

Include short fragments, ambiguous pronouns, corrections, sarcasm, repeated
meaning in different words, and messages mentioning several aspects. Avoid
making every person articulate, cooperative or equally verbose. Silence creates
no testimony; a closed campaign need not contain 100 completed questionnaires.

### Use bounded Luna batches

1. Confirm the question contract and replay/import shape against existing
   simulator tooling. Identify any required implementation separately.
2. Review a small pilot of ten conversations before bulk generation.
3. Assign roughly ten batches of ten attendee profiles to Luna. Each batch mixes
   outcomes and themes; do not give one agent all pacing complaints. Start with at
   most three concurrent agents and a fixed output/call budget.
4. Save each accepted batch with stable scenario/message IDs, model identifier,
   prompt version and generation settings. Resume missing batches, preserving
   accepted output. A prompt seed is not a claim of deterministic generation.
5. Check ID uniqueness, profile coverage, role order, explicit endings, unsupported
   participant knowledge and duplicate prose. Review representative conversations
   and every deliberately difficult case before freezing the corpus.

Generation prompts must include this compact contract:

> Write only the assigned fictional participants. Follow the event brief,
> participant-specific knowledge and approved interview contract. Preserve each
> person's style, uncertainty and willingness to answer. Do not steer them toward
> target categories or manufacture a complete answer. Return stable IDs and
> role-labeled messages separately from expected findings and evidence references.

Do not launch the bulk agents merely because this task card exists. Finish the
pilot and prompt first; native Codex Luna agents are the requested execution path.

### Separate extraction replay from bot-behavior testing

Authored human-and-bot transcripts are **fixtures**, not evidence that the actual
bot behaves that way. Replay them through the real extraction boundary to inspect
what is captured. If evaluating turn taking and follow-up behavior, Luna plays
only the human and the actual application produces bot turns. Do not present the
two modes as equivalent or buy both full corpora by default.

Expected findings live separately from extractor input. For each important case,
record what should be captured, its source message IDs, corrections that supersede
earlier testimony, and what must not be inferred. Agent-written expectations are
drafts until reviewed. Compare meaning and evidence, not exact summary wording or
unstable cluster IDs. Count people separately from notes and messages.

Use the reviewed pilot as a focused regression set; keep additional participants
for the campaign showcase. Save actual extraction results and inspect omissions,
unsupported findings and lost qualifiers before running clustering. Generation
and provider-backed replay are explicit bounded runs, not paid CI requirements.

## Completion criteria

- An agreed event questionnaire and executable replay path exist; any adaptation
  to the current V2 assumptions is implemented and documented first.
- All 100 fictional attendee outcomes are accounted for, with no invented replies
  for silent participants and explicit partial/declined outcomes.
- The pilot, shared prompt, batch assignments, frozen artifacts and reviewed
  expected findings are available and clearly marked synthetic.
- A repeatable extraction run reports observed results and concrete discrepancies;
  unacceptable findings are corrected or explicitly left open.
- Topic analysis consumes those extracted notes and preserves source references;
  no claim that fixture generation proves real-world response rates or quality.

This task does not complete the analysis UI, legacy-summary rewrite, public demo,
visitor isolation or voice integration. Those remain their own deliverables.
