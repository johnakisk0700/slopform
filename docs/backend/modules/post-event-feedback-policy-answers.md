# Post-event feedback: what we are allowed to say

**Status: adopted. The owner approved the seven proposed sentences verbatim on
2026-08-01, and the mechanism below is wired.** The answers remain the owner's
decision, not an engineering one: editing a sentence here without changing
`apps/backend/src/modules/post-event-feedback/extraction/policy-answers.ts` in
the same commit fails `policy-answers.spec.ts`, which is what keeps this file
the source of record rather than a stale intention.

## Why this file exists

Rule 11στ forbids the model from saying anything at all about what we do with
somebody's answers: where they are stored, who reads them, how long we keep
them, whether they are anonymous, whether they affect future tables. The rule is
right — a sentence the model invents is a commitment the platform has to keep,
and it invents URLs and retention periods as readily as anything else.

But the rule is a hole, not an answer, and it is currently the longest rule in
the prompt: about a thousand characters spent describing what the bot does not
know. When Λούλα Γκροκούλα asked four times what happens to what she says, she
got the same deferral four times, near-verbatim, and the fourth one opened with
the bot admitting «το έκανα λίγο copy-paste 😄». Her question is also recorded
nowhere: six notes captured everything about her evening and none of them says
she asked.

The answers below are meant to close that. Once a question has an approved
sentence, nothing has to be invented and nothing has to be deferred.

## How it is meant to work

1. This file is the source. One entry per question, one approved sentence each.
2. The attention classifier — the call that already runs on every turn, at
   reasoning effort `none` — gains one field, `policyQuestion`, alongside
   `hostileToUs` and `incidentDescribed`. It receives **the ids and what each
   one asks, never the answers.**
3. The extraction model is unchanged. Rule 11στ stays exactly as it is: it still
   must never say anything about data handling of its own.
4. The application appends the approved sentence, the way it appends the safety
   assurance in `apps/backend/src/modules/post-event-feedback/extraction/outbound-reply.ts`
   — same text every time, and it can read the transcript to know it has already
   said it.
5. A question that matches nothing gets today's deferral, once, plus a note so a
   person sees that it was asked.

The property that matters: **the classifier sees the questions, the application
owns the answers.** No model ever holds a policy sentence in context, so no
model can paraphrase, soften or leak one. A misclassification answers a
neighbouring question with a sentence that is still true; a generated answer to
the same question invents policy. That asymmetry is the whole reason for the
split.

## Status legend

- **Approved** — the application appends this, word for word.
- **Proposed** — drafted here, awaiting the owner. _(none left)_
- **Deliberately unanswered** — we know the question and have decided the bot
  does not answer it. Deferral plus a note.
- **Needs a decision outside engineering** — likely legal, not a wording choice.

## The confidentiality commitment

V1 `avoid` copy ended with **«Μένει αυστηρά μεταξύ μας»**. Existing V1 campaign
snapshots keep that exact text, so it remains a commitment for those
participants. V2 deliberately narrows the wording: the answer is confidential
and is not disclosed to other attendees, but it is **not anonymous** — it stays
linked to the respondent and named subject so a human can review future table
matching. The questionnaire must not promise absolute secrecy that conflicts
with access, rights handling or legal obligations.

`will_they_find_out` below is still the owner-approved application answer. Its
relationship to the final privacy notice, Article 14 handling and any lawful
disclosure exception is part of the pre-activation legal review; engineering
must not silently soften or broaden it in generated model copy.

## The questions

### `what_is_it_for`

**They ask:** why are you asking me all this, what do you do with it.

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

This one is load-bearing. It is the question people ask before they tell the
truth about somebody, and it is the promise the `avoid` copy already makes.

### `affects_next_tables`

**They ask:** does this change who I get seated with.

**Approved:** «Ναι, αυτό ακριβώς είναι — το λαμβάνουμε υπόψη όταν φτιάχνουμε τα
επόμενα τραπέζια. Δεν είναι αυτόματο, το βλέπει άνθρωπος.»

The second sentence is a claim of fact the owner confirmed on 2026-08-01: a
person reviews feedback before the next tables are seated. If seating is ever
automated, this entry has to change on the same day.

### `show_me_what_others_said`

**They ask:** show me what X wrote about me.

**Approved:** «Δεν μπορώ να σου δείξω τι έγραψε άλλος άνθρωπος — όπως δεν
δείχνω σε κανέναν τι έγραψες εσύ.»

Already handled correctly today by rule 11ε, and it worked at the last
rehearsal: Κώστας Μυτοχωνάκιας tried it as a prompt injection and got refused.
It is written down here so the refusal and the confidentiality promise are
visibly the same promise.

### `where_did_you_get_my_number`

**They ask:** how do you have my number.

**Approved:** «Από την εγγραφή σου στο Join The Six, για το δείπνο στο οποίο
ήσουν.»

### `are_you_a_bot`

**They ask:** are you a person or a machine.

**Approved:** «Είμαι αυτοματοποιημένο μήνυμα από την ομάδα του Join The Six —
όχι άνθρωπος. Ό,τι μου γράψεις το διαβάζει άνθρωπος.»

Worth noticing while writing this list: **the prompt has no rule about this at
all.** The real-model corpus grades it from both sides — `disclose_bot_identity`
as a required intent and `claim_human_identity` as a forbidden one — so a model
that claims to be human fails the eval, but nothing in the instructions tells it
not to. It has behaved correctly so far on its own. That is a gap whether or not
this file is adopted.

The second sentence is only true if it is: it is a claim about who reads the
conversation, so it has to agree with `who_sees_it` above.

### `stop_messaging_me`

**They ask:** stop writing to me.

**Answered by the mechanism, not by a sentence.** ΣΤΟΠ is handled end to end and
has its own copy. Listed so nobody adds a second, competing answer.

### `delete_my_data`

**They ask:** delete what I told you.

**Deliberately unanswered — this stays a handoff.** It is a real right, the bot
cannot execute it, and rule 11ε forbids promising that somebody will. The
current path already works: the request becomes a note, the conversation is
flagged, and the handoff copy says a person will be in touch. Adding a canned
sentence here would be the bot answering a request it cannot carry out.

### `how_long_kept`

**They ask:** how long do you keep this.

**Needs a decision outside engineering — deliberately unanswered for now**
(owner, 2026-08-01). Until an answer exists: deferral once, plus an
`unanswered_data_question` attention reason so a person sees it was asked.

### `is_it_anonymous`

**They ask:** is this anonymous.

**Architecture fact: it is not anonymous. Approved participant-facing sentence
still needs a decision outside engineering.** The answer is tied to the
respondent and, for directed feedback, the named subject so it can support
human-reviewed seating. That fact must appear in the final layered notice, but
the bot's exact sentence is worth approving alongside retention, access and
rights handling rather than improvising it in the model. Deliberately unanswered
for now (owner, 2026-08-01): deferral once, plus an
`unanswered_data_question` attention reason.

## The link

There is no `/policy/` page, which is why rule 11στ forbids the bot from
offering one — left to itself it invents a plausible URL. When the page exists,
it is one line in this file and it appears in every relevant answer at once. That
is a reason to keep the answers here rather than in the prompt, not a reason to
wait for the page.

## How it is wired (since 2026-08-01)

- The classifier result carries `policyQuestion` — one id per message, nullable,
  independent of every safety field (`attention-classification.ts`). The prompt
  lists the ids with what each one asks; `attention-classification.spec.ts`
  asserts no approved sentence ever appears in it.
- `withPolicyAnswers` in `extraction/outbound-reply.ts` appends the approved
  sentence to whatever the run was already sending — same shape as the safety
  assurance, deduped against the transcript per sentence, so asking twice gets
  the answer once.
- A recognised question with no approved answer — retention, anonymity,
  `other_data_handling` — earns the model's deferral plus an
  `unanswered_data_question` attention reason anchored on the asking message.
  `delete_my_data` is the exception: the handoff path already owns it.
- The same change gave the closing copy a quiet variant
  (`closing_after_safety`): a conversation carrying an unresolved `safety`
  reason no longer closes with «Τέλεια! 🙌».

The list does not have to be complete. Every unmatched question leaves an
attention reason, so after a rehearsal or two the reasons say what people
actually ask and the list grows from evidence instead of from guessing.

Still open, deliberately: `how_long_kept` and `is_it_anonymous` wait on a
decision that is not a wording choice, and the `/policy/` page does not exist —
when it does, it is one line here and one in the table. Questionnaire V2 also
stays pre-activation until the product/privacy owner closes the legal-basis and
layered-notice decision, retention and deletion implementation, DPIA sign-off,
and processor/subprocessor/data-transfer review for WhatsApp, Wasender and every
enabled model route. No final basis, retention period or URL is implied here.
