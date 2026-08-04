# Post-event feedback: what we are allowed to say

**Status: adopted and wired (owner approved 2026-08-01).** This file is the
human-readable source of record for approved participant-facing policy
sentences. Editing a sentence here without updating
`apps/backend/src/modules/post-event-feedback/extraction/policy-answers.ts` in
the same commit fails `policy-answers.spec.ts`.

Mechanism (classifier field, append path, deferral + attention) lives in the
[post-event feedback module](post-event-feedback.md) —
`attention-classification.ts` and `withPolicyAnswers` in
`extraction/outbound-reply.ts`. This page is the wording table and the decisions
behind it, not the orchestration guide.

## Design rule

Rule 11στ forbids the model from inventing data-handling commitments. Approved
answers close that hole: the attention classifier receives **ids and what each
asks, never the answers**; the application appends the approved sentence
(deduped against the transcript). Unmatched questions get today's deferral once
plus an attention note. **Classifier sees questions; application owns answers.**

### Status legend

- **Approved** — application appends this verbatim.
- **Deliberately unanswered** — deferral + note (or handoff path).
- **Needs a decision outside engineering** — legal/product, not wording.

## Confidentiality commitment

V1 `avoid` copy ended with **«Μένει αυστηρά μεταξύ μας»**; existing V1 campaign
snapshots keep that text. V2 narrows: confidential and not disclosed to other
attendees, but **not anonymous** — linked to respondent and named subject for
human-reviewed seating. `will_they_find_out` below remains the owner-approved
application answer; its relationship to privacy notice, Article 14 and lawful
disclosure is part of pre-activation legal review. Do not soften or broaden it
in generated model copy.

## The questions

### `what_is_it_for`

**They ask:** why are you asking / what do you do with it.

**Approved:** «Τα χρησιμοποιούμε για να φτιάχνουμε καλύτερες παρέες στα επόμενα
τραπέζια — ποιος ταιριάζει με ποιον. Τίποτα άλλο.»

### `who_sees_it`

**They ask:** who reads what I write.

**Approved:** «Τα διαβάζει μόνο η ομάδα του Join The Six. Κανείς από την παρέα
σου δεν βλέπει τι έγραψες.»

### `will_they_find_out`

**They ask:** will X find out I said that / that I avoided them.

**Approved:** «Όχι. Ό,τι μου λες για την παρέα δεν φτάνει ποτέ σε αυτούς — ούτε
ότι το είπες.»

Load-bearing; matches the `avoid` confidentiality promise.

### `affects_next_tables`

**They ask:** does this change who I get seated with.

**Approved:** «Ναι, αυτό ακριβώς είναι — το λαμβάνουμε υπόψη όταν φτιάχνουμε τα
επόμενα τραπέζια. Δεν είναι αυτόματο, το βλέπει άνθρωπος.»

Second sentence is an owner-confirmed fact (2026-08-01). If seating is ever
automated, change this entry the same day (and the TypeScript definition).

### `show_me_what_others_said`

**They ask:** show me what X wrote about me.

**Approved:** «Δεν μπορώ να σου δείξω τι έγραψε άλλος άνθρωπος — όπως δεν
δείχνω σε κανέναν τι έγραψες εσύ.»

Aligns with rule 11ε.

### `where_did_you_get_my_number`

**They ask:** how do you have my number.

**Approved:** «Από την εγγραφή σου στο Join The Six, για το δείπνο στο οποίο
ήσουν.»

### `are_you_a_bot`

**They ask:** person or machine.

**Approved:** «Είμαι αυτοματοποιημένο μήνυμα από την ομάδα του Join The Six —
όχι άνθρωπος. Ό,τι μου γράψεις το διαβάζει άνθρωπος.»

Second sentence must stay consistent with `who_sees_it`.

### `stop_messaging_me`

**Answered by the STOP mechanism, not a sentence here.** Listed so nobody adds
a competing canned answer.

### `delete_my_data`

**Deliberately unanswered — handoff owns it.** Bot cannot execute deletion;
rule 11ε forbids promising that somebody will. Request → note + flag + handoff
copy. Excluded from the unanswered-policy attention raise so it is not flagged
twice.

### `how_long_kept`

**Needs a decision outside engineering — deliberately unanswered** (owner,
2026-08-01). Until then: deferral once + `unanswered_data_question`.

### `is_it_anonymous`

**Architecture fact: not anonymous. Participant-facing sentence still needs a
decision outside engineering.** Deliberately unanswered for now (owner,
2026-08-01): deferral once + `unanswered_data_question`. The layered notice must
eventually state the link to respondent/subject; do not invent a bot sentence.

## Wiring notes (since 2026-08-01)

- Classifier: nullable `policyQuestion` per message; prompt lists ids + asks;
  specs assert no approved sentence appears in the classifier prompt.
- `withPolicyAnswers` appends approved text (same shape as safety assurance),
  deduped per sentence against the transcript.
- Recognised question with no approved answer (`how_long_kept`,
  `is_it_anonymous`, `other_data_handling`) → model deferral +
  `unanswered_data_question` (except `delete_my_data`, handoff-owned).
- Closing copy quiet variant `closing_after_safety` when an unresolved `safety`
  reason is present.

No `/policy/` page exists — rule 11στ forbids inventing a URL. When it does,
add one line here and surface it in every relevant answer.

Still open: retention, anonymity wording, and questionnaire V2 pre-activation
legal gates (basis, layered notice, retention/deletion, DPIA,
processor/subprocessor/transfer review). No final basis, retention period or
URL is implied here. See
[pre-activation privacy gate](post-event-feedback.md#pre-activation-privacy-gate-open).
