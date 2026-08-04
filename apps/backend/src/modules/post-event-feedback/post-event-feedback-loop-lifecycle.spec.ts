import { expect } from "vitest";

import {
  runFeedbackScenarios,
  type FeedbackScenario,
  type FeedbackStep,
} from "./post-event-feedback-loop.harness.js";
import { POST_EVENT_FEEDBACK_QUESTION_SET_V1 } from "./question-set.js";

/**
 * Sections **C. Stopping, silence and time** and **I. Machinery, seen from the
 * outside** of `docs/backend/modules/post-event-feedback-scenarios.md`.
 *
 * Two things bind this file together: the participant who wants the
 * conversation to end, and the clock that ends it for them. Everything in
 * section C is one of those two — a person asking to be left alone, or a person
 * who simply stopped typing — and section I is the machinery that has to hold
 * while both happen: a provider redelivering, a transcript filling up, a
 * campaign being paused, a person repeating themselves.
 *
 * Shape, assertions and the ledger all follow `post-event-feedback-loop.spec.ts`
 * and the harness header. Two to four facts per scenario, `toMatchObject` only,
 * never the model's wording — but the STOP acknowledgement, the reminder and
 * the closing line are copy the application owns, so those may be asserted by
 * text.
 *
 * ## The product decisions these scenarios encode
 *
 * **Nudges.** A reminder after 24 hours of *silence*, a second after 48, close
 * after 72, at most two reminders ever. Silence is measured from the last
 * participant message, falling back to launch when they never replied at all;
 * our own outbound never resets it. The nudge restates the question they
 * stopped at, and a conversation flagged for attention is never nudged at all.
 *
 * These rows were written as F1/F2 ledger entries against a sweep that measured
 * from `createdAt`, sent at most one reminder, and skipped anyone who had ever
 * replied — which excluded exactly the half-finished participants worth
 * chasing. WP4 fixed it and the labels were cleared; they are ordinary
 * regressions now.
 *
 * **Post-closure retention.** A conversation closed by `stopped` keeps metadata
 * only for anything that arrives afterwards: somebody who opted out of hearing
 * from us did not opt out of speaking to us, but their words are not retained.
 * `completed` and `expired` keep the full text. All three raise attention.
 * Today all three destroy the text — F3.
 *
 * **STOP matching.** The word survives trailing punctuation and surrounding
 * politeness, and a plain-language opt-out counts. These rows were written as
 * `STOP-NARROW` ledger entries against a matcher that compared whole strings
 * without folding punctuation — «ΣΤΟΠ!», «stop.», «STOP!!!», «Στοπ ευχαριστώ»
 * and «μη μου ξαναστείλετε» all fell through to the model as ordinary
 * testimony. WP0 fixed it, the rows turned red, and the labels were cleared.
 * They are ordinary regressions now.
 */

const COPY = POST_EVENT_FEEDBACK_QUESTION_SET_V1.copy;

/**
 * What every STOP-shaped message must do, whichever way it was typed: the
 * conversation ends, the standing consent goes with it, and the participant
 * hears our acknowledgement exactly once.
 */
const STOPPED = {
  lifecycle: "closed",
  closedBecause: "stopped",
  optedIn: false,
  received: [{ kind: "stop_ack", text: COPY.stop_ack }],
} as const;

/** 149 ordinary turns, which is the transcript cap minus the seeded intro. */
const FILL_TRANSCRIPT_TO_CAP: readonly FeedbackStep[] = Array.from(
  { length: 149 },
  (_, index): FeedbackStep => ({
    kind: "inbound",
    text: `μήνυμα ${index + 1}`,
    after: "1s",
  }),
);

const STOPPING_SILENCE_AND_TIME: readonly FeedbackScenario[] = [
  {
    // S15. The word the intro told them to use, typed exactly.
    id: "stop_uppercase_greek",
    title: "closes, withdraws consent and acknowledges a bare ΣΤΟΠ",
    steps: [{ kind: "inbound", text: "ΣΤΟΠ" }],
    expect: STOPPED,
  },
  {
    // S16a. The same person, one keystroke different.
    id: "stop_with_an_exclamation_mark",
    title: "treats «ΣΤΟΠ!» as a stop",
    steps: [{ kind: "inbound", text: "ΣΤΟΠ!" }],
    expect: STOPPED,
  },
  {
    // S17. Does not know there is a magic word, and says the thing plainly.
    // The reminder assertion is the sting: today this person is still on the
    // list, so a day later we message them again.
    id: "plain_language_optout",
    title:
      "treats a plain-language opt-out as a stop, and never nudges after it",
    steps: [
      { kind: "inbound", text: "μη μου ξαναστειλετε ρε παιδια, φτανει" },
      { kind: "wait", after: "25h" },
    ],
    expect: {
      lifecycle: "closed",
      closedBecause: "stopped",
      optedIn: false,
      receivedCount: { reminder: 0 },
    },
  },
  {
    // S18. Finished the questionnaire, got the thank-you, and only then decided
    // they never want to hear from us again. `close()`'s precedence rule is
    // right; nothing ever reaches it, because the lookup only sees open
    // conversations.
    id: "stop_after_the_thanks",
    title: "upgrades a completed conversation to stopped and withdraws consent",
    seed: { closed: "completed" },
    steps: [{ kind: "inbound", text: "ΣΤΟΠ", after: "3m" }],
    expect: {
      closedBecause: "stopped",
      optedIn: false,
      receivedCount: { stop_ack: 1 },
    },
  },
  {
    // S19. Answered the first question with enthusiasm and then vanished. The
    // most valuable non-responder in the campaign — and the one the sweep used
    // to skip, because having replied once excluded them from reminders.
    id: "goes_silent_mid_questionnaire",
    title:
      "nudges a half-finished participant twice across two days of silence",
    script: [
      {
        answers: [{ question: "event_score", value: 5 }],
        next: "liked",
        reply: "Χαιρόμαστε πολύ! Ξεχώρισε κάποιος από την παρέα;",
      },
    ],
    steps: [
      { kind: "inbound", text: "5 ναι, γαματη φαση" },
      { kind: "wait", after: "settles" },
      { kind: "wait", after: "49h" },
    ],
    expect: {
      answers: [{ question: "event_score", about: null, value: 5 }],
      receivedCount: { reminder: 2 },
      lifecycle: "open",
    },
  },
  {
    // The nudge ladder in one row: two reminders and no more, then closure.
    // Both the cap and the second rung matter — the reminder used to be a
    // single timestamp, so nobody was ever asked twice.
    id: "nudges_twice_then_closes",
    title:
      "sends at most two reminders, then closes after three days of silence",
    steps: [{ kind: "wait", after: "73h" }],
    expect: {
      receivedCount: { reminder: 2 },
      lifecycle: "closed",
      closedBecause: "expired",
    },
  },
  {
    // The nudge has to know what it is nudging about. The generic invitation
    // asks somebody to tell us how the evening went; sending that to a person
    // who told us «5, γαμάτη φάση» yesterday reads as "we lost what you sent",
    // and that person is precisely who the ladder was built to reach.
    id: "nudge_restates_the_open_question",
    title:
      "nudges a half-finished participant with the question they stopped at",
    script: [
      {
        answers: [{ question: "event_score", value: 5 }],
        next: "liked",
        reply: "Χαιρόμαστε πολύ! Ξεχώρισε κάποιος από την παρέα;",
      },
    ],
    steps: [
      { kind: "inbound", text: "5 ναι, γαματη φαση" },
      { kind: "wait", after: "settles" },
      { kind: "wait", after: "25h" },
    ],
    expect: {
      receivedCount: { reminder: 1 },
      received: [
        { kind: "reply" },
        { kind: "reminder", text: expect.stringContaining(COPY.liked) },
      ],
    },
  },
  {
    // The nudge ladder must not walk into a conversation a person has been
    // asked to look at. Silence after a flag is very often *caused* by what was
    // flagged, and «πες μας και για τα υπόλοιπα» is the worst thing that could
    // arrive next. Expiry is deliberately not held back the same way — it sends
    // nothing.
    id: "flagged_conversation_is_never_nudged",
    title: "does not nudge a conversation that is waiting for a human",
    script: [
      {
        answers: [{ question: "event_score", value: 2 }],
        notes: [
          {
            type: "general",
            text: "Περιγράφει ότι κάποιος της φέρθηκε πολύ άσχημα στο τραπέζι.",
          },
        ],
        next: "liked",
        reply: "Λυπόμαστε πολύ που το άκουσμα αυτό. Το προωθούμε στην ομάδα.",
      },
    ],
    attention: [[{ category: "harassment", action: "human_follow_up" }]],
    steps: [
      {
        kind: "inbound",
        text: "2. μου φερθηκε απαισια καποιος εκει και δε θελω να το ξαναζησω",
      },
      { kind: "wait", after: "settles" },
      { kind: "wait", after: "49h" },
    ],
    expect: {
      needsAttention: true,
      receivedCount: { reminder: 0 },
      lifecycle: "open",
    },
  },
  {
    // Silence is measured from the participant's last message, so somebody who
    // answered at hour 20 is not due at hour 24. Its pair below proves this row
    // passes for the right reason: reminders reach people who have replied,
    // they are just counted from the reply.
    id: "silence_clock_resets_on_a_reply",
    title: "does not nudge within a day of the participant's own last message",
    script: [{}],
    steps: [
      { kind: "wait", after: "20h" },
      { kind: "inbound", text: "5αρι" },
      { kind: "wait", after: "10h" },
    ],
    expect: {
      receivedCount: { reminder: 0 },
      lifecycle: "open",
    },
  },
  {
    // The other half of the same rule: a day after *their* message, they are
    // due — not a day after we launched.
    id: "reminder_follows_the_last_reply",
    title:
      "nudges a day after the participant's own last message, not a day after launch",
    script: [{}],
    steps: [
      { kind: "wait", after: "20h" },
      { kind: "inbound", text: "5 λεω" },
      { kind: "wait", after: "25h" },
    ],
    expect: {
      receivedCount: { reminder: 1 },
      lifecycle: "open",
    },
  },
  {
    // S20. Busy week, opens WhatsApp on day three and starts answering
    // properly. The expiry clock should measure silence, not age.
    id: "replies_at_hour_71",
    title: "keeps a conversation open when the participant engaged an hour ago",
    script: [
      {
        answers: [{ question: "event_score", value: 4 }],
        next: "liked",
        reply: "Ευχαριστούμε! Ξεχώρισε κάποιος από την παρέα;",
      },
    ],
    steps: [
      {
        kind: "inbound",
        text: "σορρυ τωρα το ειδα. 4",
        after: "71h",
      },
      { kind: "wait", after: "70m" },
    ],
    expect: {
      lifecycle: "open",
      closedBecause: null,
      answers: [{ question: "event_score", about: null, value: 4 }],
    },
  },
  {
    // S21. Genuinely late, and answers everything well. The conversation has
    // already expired underneath them, so a complete answer set arrives at a
    // door that is shut. Keep the words, raise the flag, say nothing back.
    id: "replies_four_days_later",
    title:
      "keeps what arrives after expiry and calls an operator without replying",
    steps: [
      {
        kind: "inbound",
        after: "96h",
        text: "ωχ τωρα το ειδα 😬 5. ο Νικος φοβερος, ναι θα τον ξαναεβλεπα",
      },
    ],
    expect: {
      closedBecause: "expired",
      lostParticipantText: [],
      needsAttention: true,
      receivedCount: { reply: 0 },
    },
  },
  {
    // The retention decision, stated as a scenario. Somebody who opted out of
    // receiving messages did not opt out of sending one — but after an explicit
    // STOP we keep the fact, not the words. The flag is what an operator acts
    // on, and it is the half that is missing today.
    id: "stopped_conversation_keeps_only_metadata",
    title:
      "keeps metadata but not the words when someone writes after stopping",
    seed: { closed: "stopped" },
    steps: [
      {
        kind: "inbound",
        after: "2h",
        text: "τελικα ηταν μια χαρα παντως",
      },
    ],
    expect: {
      retainedParticipantText: [],
      needsAttention: true,
      received: [],
    },
  },
  {
    // S23. Staff toggled the opt-in off after a phone call and nobody closed
    // the conversation. It has to close on its own, or the partial unique index
    // on the phone blocks the next campaign's launch for this person.
    id: "opted_out_but_never_stopped",
    title:
      "closes a stale conversation whose participant is no longer opted in",
    seed: { optedIn: false },
    steps: [{ kind: "wait", after: "73h" }],
    expect: {
      lifecycle: "closed",
      closedBecause: "expired",
      receivedCount: { reminder: 0 },
    },
  },
];

const MACHINERY_FROM_THE_OUTSIDE: readonly FeedbackScenario[] = [
  {
    // S54. Nobody typed three times; the provider delivered once and repeated
    // itself. Worth an explicit row because the ingress service re-enqueues on
    // a redelivery on purpose — the first enqueue may have been lost — so the
    // idempotency has to hold at materialize time, not at insert time.
    id: "duplicate_webhook_delivery",
    title:
      "absorbs a redelivered webhook into one message, one answer, one reply",
    script: [
      {
        answers: [{ question: "event_score", value: 5 }],
        next: "liked",
        reply: "Ευχαριστούμε! Ξεχώρισε κάποιος από την παρέα;",
      },
    ],
    steps: [
      { kind: "inbound", text: "5", providerMessageId: "wa-redelivered" },
      {
        kind: "inbound",
        text: "5",
        after: "1s",
        providerMessageId: "wa-redelivered",
      },
      {
        kind: "inbound",
        text: "5",
        after: "30s",
        providerMessageId: "wa-redelivered",
      },
      { kind: "wait", after: "settles" },
    ],
    expect: {
      answers: [{ question: "event_score", about: null, value: 5 }],
      receivedCount: { reply: 1 },
      transcript: [
        { who: "bot", kind: "intro" },
        { who: "participant", text: "5" },
        { who: "bot", kind: "reply" },
      ],
    },
  },
  {
    // S56. WhatsApp says which fragment was observed first even when webhooks
    // arrive backwards. Human-readable transcript order must follow the sender,
    // otherwise a split thought is quietly rewritten.
    id: "out_of_order_webhooks",
    title:
      "shows two fragments in the order the participant sent them, not the order webhooks arrived",
    script: [
      {
        answers: [
          {
            question: "event_score",
            value: 5,
            cite: ["ο Νικο", "5 λεω"],
          },
          {
            question: "liked",
            about: "Νίκος",
            cite: ["ο Νικο", "5 λεω"],
          },
        ],
        next: "meet_again",
        reply: "Οκ. Και θα ήθελες να ξαναβρεθείς με τον Νίκο;",
      },
    ],
    steps: [
      {
        kind: "inbound",
        text: "5 λεω",
        after: "3s",
        observedAt: "2s",
      },
      {
        kind: "inbound",
        text: "ο Νικο",
        after: "1s",
        observedAt: 0,
      },
      { kind: "wait", after: "settles" },
    ],
    expect: {
      answers: [
        { question: "event_score", about: null, value: 5 },
        { question: "liked", about: "Νίκος", value: null },
      ],
      transcript: [
        { who: "bot", kind: "intro" },
        { who: "participant", text: "ο Νικο" },
        { who: "participant", text: "5 λεω" },
        { who: "bot", kind: "reply" },
      ],
    },
  },
  {
    // S55. WhatsApp's edit feature, or a provider redelivering the same id with
    // different words. Whether the edit becomes a new turn or is refused
    // outright, the correction a participant deliberately made must not
    // evaporate in silence.
    id: "edited_message_redelivered",
    title:
      "keeps an edited redelivery and flags the conversation rather than dropping it",
    script: [{}],
    steps: [
      {
        kind: "inbound",
        text: "ο Κωστας ηταν χαλια",
        providerMessageId: "wa-edited",
      },
      {
        kind: "inbound",
        text: "ο Κωστας τελικα ηταν οκ",
        after: "40s",
        providerMessageId: "wa-edited",
      },
      { kind: "wait", after: "settles" },
    ],
    expect: {
      lostParticipantText: [],
      needsAttention: true,
    },
  },
  {
    // S57. A very chatty participant, or an operator running a long support
    // conversation in the same thread. Refusing the append is deliberate — a
    // one-sided transcript is the failure this prevents — but the words still
    // have to survive in PostgreSQL and somebody has to be told to look.
    id: "transcript_hits_the_cap",
    title: "keeps the message and raises attention when the transcript is full",
    // The bot no longer carries on as if nothing happened — a full transcript
    // now hands the conversation to a person, because it genuinely cannot
    // record what was just said. The message itself is still only in raw
    // ingress: the transcript cap exists to stop a one-sided transcript, so
    // showing it needs a place to put it rather than a bigger cap.
    defect:
      "CAPACITY-SILENCE: the final message remains only in raw ingress and is not human-visible in the conversation",
    knownCurrent: {
      lostParticipantText: ["κ κατι τελευταιο, θενκς για ολα"],
      needsAttention: true,
    },
    allowUnscriptedExtractionCalls: true,
    steps: [
      ...FILL_TRANSCRIPT_TO_CAP,
      { kind: "wait", after: "settles" },
      { kind: "inbound", text: "κ κατι τελευταιο, θενκς για ολα" },
      { kind: "wait", after: "settles" },
    ],
    expect: {
      lostParticipantText: [],
      needsAttention: true,
    },
  },
  {
    // S58. The kill switch freezes model work as well as outbound delivery.
    // Testimony stays unread in MongoDB and resume replans it from current state;
    // paying to classify it while paused would make "pause" decorative.
    id: "campaign_paused_midflow",
    title: "parks unread testimony without a model call while paused",
    seed: { campaign: "paused" },
    script: [],
    steps: [
      { kind: "inbound", text: "5 κ ο Νικος πολυ δυνατος" },
      { kind: "wait", after: "settles" },
    ],
    expect: {
      answers: [],
      received: [],
      lifecycle: "open",
    },
  },
  {
    // A close that lands while the provider is reading is the real kill-switch
    // race: keep what the person said, but do not let the stale model snapshot
    // talk after staff closed the campaign.
    id: "campaign_closes_during_the_model_call",
    title:
      "keeps the answer but delivers no reply or reminder after the campaign closes",
    script: [
      {
        answers: [{ question: "event_score", value: 4 }],
        next: "liked",
        reply: "Το σημείωσα. Ποιος σου έκανε καλή εντύπωση;",
      },
    ],
    steps: [
      { kind: "inbound", text: "4 ηταν οκ" },
      {
        kind: "during_model",
        after: "settles",
        action: { kind: "campaign", status: "closed" },
      },
      { kind: "wait", after: "settles" },
      { kind: "wait", after: "25h" },
    ],
    expect: {
      answers: [{ question: "event_score", about: null, value: 4 }],
      receivedCount: { reply: 0, reminder: 0 },
      lifecycle: "open",
    },
  },
  {
    // A provider rejection is not a delivered reply. The structured answer is
    // still useful, while the failed send must become visible human work — a
    // participant who "went quiet" after a question they were never sent looks
    // exactly like one who ignored it, and telling those apart is the whole
    // reason somebody opens the inbox.
    id: "reply_delivery_rejected",
    title:
      "records the answer, reports the failed delivery and never pretends the participant received the reply",
    script: [
      {
        answers: [{ question: "event_score", value: 5 }],
        next: "liked",
        reply: "Οκ. Ποιος σου έκανε καλή εντύπωση;",
      },
    ],
    steps: [
      { kind: "transport", outcome: "not-accepted" },
      { kind: "inbound", text: "5, μια χαρα" },
      { kind: "wait", after: "settles" },
      { kind: "transport", outcome: "accepted" },
      { kind: "wait", after: "1h" },
    ],
    expect: {
      answers: [{ question: "event_score", about: null, value: 5 }],
      received: [],
      needsAttention: true,
    },
  },
  {
    // S59. Convinced the message did not send, so they send it five times. The
    // data is right either way; what they must not get is a reply per copy,
    // which is precisely the behaviour that made them repeat themselves.
    id: "sends_the_same_message_five_times",
    title:
      "records one score and answers once when the same message is sent five times",
    // One scripted turn: five copies sent 20-25 seconds apart never let a run
    // come due, so the whole thing settles into a single read.
    script: [
      {
        answers: [{ question: "event_score", value: 5 }],
        next: "liked",
        reply: "Ευχαριστούμε! Ξεχώρισε κάποιος από την παρέα;",
      },
    ],
    steps: [
      { kind: "inbound", text: "5" },
      { kind: "inbound", text: "5", after: "20s" },
      { kind: "inbound", text: "5", after: "25s" },
      { kind: "inbound", text: "5", after: "25s" },
      { kind: "inbound", text: "5", after: "25s" },
      { kind: "wait", after: "settles" },
    ],
    expect: {
      answers: [{ question: "event_score", about: null, value: 5 }],
      receivedCount: { reply: 1 },
    },
  },
  {
    // S60. Three dinners in, answering this campaign's questions about last
    // month's table. Live candidate selection is the only thing standing
    // between that and a sexual remark landing on an innocent profile, so the
    // names degrade to flagged, subjectless notes rather than being guessed.
    id: "answers_about_the_wrong_dinner",
    title: "refuses to direct answers at people who were not at this dinner",
    script: [
      {
        answers: [
          { question: "liked", about: "Ρούλα" },
          { question: "liked", about: "Θανάσης" },
        ],
        notes: [
          { type: "general", text: "Η Ρούλα ήταν φοβερή.", about: "Ρούλα" },
          {
            type: "general",
            text: "Ο Θανάσης ήταν φοβερός.",
            about: "Θανάσης",
          },
        ],
        reply: "Ευχαριστούμε! Πες μας και για τη βαθμολογία της βραδιάς.",
      },
    ],
    steps: [
      {
        kind: "inbound",
        text: "καλα ηταν. η Ρουλα κ ο Θανασης πολυ καλοι",
      },
      { kind: "wait", after: "settles" },
    ],
    expect: {
      answers: [],
      notes: [
        { about: null, flagged: true },
        { about: null, flagged: true },
      ],
      needsAttention: true,
    },
  },
];

runFeedbackScenarios(
  "post-event feedback loop — stopping, silence and time",
  STOPPING_SILENCE_AND_TIME,
  { questionSetVersion: 1 },
);

runFeedbackScenarios(
  "post-event feedback loop — machinery, seen from the outside",
  MACHINERY_FROM_THE_OUTSIDE,
  { questionSetVersion: 1 },
);
