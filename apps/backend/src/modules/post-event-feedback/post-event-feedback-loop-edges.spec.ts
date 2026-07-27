import {
  runFeedbackScenarios,
  type FeedbackScenario,
} from "./post-event-feedback-loop.harness.js";
import { POST_EVENT_FEEDBACK_QUESTION_SET_V1 } from "./question-set.js";

/**
 * Seven representative seams the other loop suites leave open: STOP precision,
 * a dozen-plus citation burst, safety followed by ordinary chat, and consent
 * changes that cross another behaviour.
 *
 * Shape, assertions and the ledger all follow `post-event-feedback-loop.spec.ts`
 * and the harness header. Two to four facts per scenario, `toMatchObject` only,
 * never the model's wording — but the STOP acknowledgement is ours, so that may
 * be asserted by text.
 *
 * Deliberately not re-covered here: the full STOP phrase matrix (owned by the
 * matcher tests), score revisions and list moves (typing suite), ordinary
 * midflow disclosure (safety suite), or post-closure retention (core suite).
 */

const COPY = POST_EVENT_FEEDBACK_QUESTION_SET_V1.copy;

const STILL_OPEN = {
  lifecycle: "open",
  optedIn: true,
  receivedCount: { stop_ack: 0 },
} as const;

const STOPPED = {
  lifecycle: "closed",
  closedBecause: "stopped",
  optedIn: false,
  received: [{ kind: "stop_ack", text: COPY.stop_ack }],
} as const;

/** Thirteen unique fragments inside one quiet window — past the old citation cap. */
const CITATION_BURST = [
  "ρε παιδιά",
  "η βραδιά",
  "ήταν τέλεια",
  "χωρίς αστεία",
  "βάλε 5",
  "σίγουρα 5",
  "ο Νίκος",
  "ήταν φοβερός",
  "με έκανε",
  "να γελάω",
  "συνέχεια",
  "θα τον ξαναέβλεπα",
  "άνετα",
] as const;

const SCENARIOS: readonly FeedbackScenario[] = [
  // ── STOP false positives ──────────────────────────────────────────────────
  {
    // The matcher comment's own counter-example: objection to a question, not
    // to being messaged. A false positive here silently withdraws consent.
    id: "objects_to_a_question_not_to_messages",
    title:
      "treats «σταμάτα να ρωτάς για τον Νίκο» as ordinary chat, not a stop",
    script: [
      {
        reply: "Εντάξει, ας μιλήσουμε για κάτι άλλο. Πώς σου φάνηκε συνολικά;",
      },
    ],
    steps: [
      {
        kind: "inbound",
        text: "σταματα ρε να ρωτας για τον Νικο, δε θελω να πω γι αυτον",
      },
      { kind: "wait", after: "settles" },
    ],
    expect: {
      ...STILL_OPEN,
      received: [{ kind: "reply" }],
    },
  },
  {
    // The intro itself ends «γράψε ΣΤΟΠ.». Quoting it back is how a careful
    // reader checks the instructions — not how they opt out.
    id: "quotes_the_intro_stop_line",
    title: "does not stop when somebody quotes the intro's ΣΤΟΠ instruction",
    script: [
      {
        reply: "Ναι, αν δεν θες μηνύματα γράψε ΣΤΟΠ μόνο του. Πώς σου φάνηκε;",
      },
    ],
    steps: [
      {
        kind: "inbound",
        text: "Γεια! Αν δεν θες μηνύματα, γράψε ΣΤΟΠ.",
      },
      { kind: "wait", after: "settles" },
    ],
    expect: {
      ...STILL_OPEN,
      received: [{ kind: "reply" }],
    },
  },
  // ── Long citation burst ───────────────────────────────────────────────────
  {
    // The citation bound moved 10 → 40 so a fragmented burst that honestly
    // cites every fragment is no longer destroyed. Thirteen is past the old
    // cap and well inside the new one.
    id: "twelve_plus_fragment_citation_burst",
    title:
      "keeps an answer that honestly cites a dozen-plus fragments from one burst",
    script: [
      {
        answers: [
          {
            question: "event_score",
            value: 5,
            cite: [...CITATION_BURST],
          },
          {
            question: "liked",
            about: "Νίκος",
            cite: [...CITATION_BURST],
          },
          {
            question: "meet_again",
            about: "Νίκος",
            cite: [...CITATION_BURST],
          },
        ],
        next: "avoid",
        reply:
          "Τέλεια, τα κρατάμε όλα! Υπάρχει κάποιος που θα προτιμούσες να αποφύγεις;",
      },
    ],
    steps: [
      ...CITATION_BURST.map(
        (text, index): FeedbackScenario["steps"][number] => ({
          kind: "inbound",
          text,
          ...(index === 0 ? {} : { after: "2s" as const }),
        }),
      ),
      { kind: "wait", after: "settles" },
    ],
    expect: {
      answers: [
        { question: "event_score", about: null, value: 5 },
        { question: "liked", about: "Νίκος", value: null },
        { question: "meet_again", about: "Νίκος", value: null },
      ],
      receivedCount: { reply: 1, fallback: 0 },
      lostParticipantText: [],
    },
  },

  // ── Combinations ──────────────────────────────────────────────────────────
  {
    // Disclosure first, ordinary chat second. Safety must not freeze the
    // questionnaire or swallow the later score.
    id: "discloses_then_chats_ordinarily",
    title:
      "keeps a later ordinary score after a flagged disclosure, and stays open",
    attention: [
      [{ category: "sexual_misconduct", action: "human_follow_up" }],
      [],
    ],
    script: [
      {
        notes: [
          {
            type: "general",
            text: "Ο Κώστας Γ. την ακούμπησε στον ώμο χωρίς να θέλει.",
            about: "Κώστας Γ.",
          },
        ],
        next: "event_score",
        reply: "Ευχαριστούμε που μας το είπες. Πώς σου φάνηκε συνολικά;",
      },
      {
        answers: [{ question: "event_score", value: 4 }],
        next: "liked",
        reply: "Το σημείωσα. Ξεχώρισε κάποιος από την παρέα;",
      },
    ],
    steps: [
      {
        kind: "inbound",
        text: "ο Κωστας Γ με ακουμπαγε στον ωμο κ του λεγα αστο, δε γουσταρα",
      },
      { kind: "wait", after: "settles" },
      {
        kind: "inbound",
        text: "παντως 4 η βραδια γενικα",
        after: "8m",
      },
      { kind: "wait", after: "settles" },
    ],
    expect: {
      answers: [{ question: "event_score", about: null, value: 4 }],
      needsAttention: true,
      lifecycle: "open",
      receivedCount: { reply: 2 },
    },
  },
  {
    // Real burst shape: praise first, then STOP before the quiet window closes.
    // STOP wins without authorising a fresh model call. The pre-STOP words stay
    // visible to staff, while the bot sends nothing beyond the acknowledgement.
    id: "stop_inside_a_burst_with_testimony",
    title:
      "stops a burst without a model call and retains the words sent before STOP",
    steps: [
      { kind: "inbound", text: "5 ανετα" },
      { kind: "inbound", text: "ο Νικος ηταν φοβερος", after: "2s" },
      { kind: "inbound", text: "ΣΤΟΠ", after: "2s" },
      { kind: "wait", after: "settles" },
    ],
    expect: {
      ...STOPPED,
      receivedCount: { reply: 0, stop_ack: 1 },
      retainedParticipantText: ["5 ανετα", "ο Νικος ηταν φοβερος", "ΣΤΟΠ"],
    },
  },
  {
    // Opt-out trailing an answer in the same message. People put the answer
    // first and the opt-out after it; while phrases were anchored to the start
    // of the message, the consent half was read as testimony about the evening.
    //
    // No script: D14 decides STOP before any model call, so widening the
    // matcher also means the score in front of it is never extracted. That is
    // the intended trade — the message is a withdrawal of consent that happens
    // to open with a number, and the words themselves are still retained.
    id: "optout_trailing_an_answer",
    title:
      "treats a trailing plain-language opt-out in the same message as a stop",
    steps: [
      {
        kind: "inbound",
        text: "5 πάντως. μη μου ξαναστείλετε μηνύματα παρακαλώ",
      },
      { kind: "wait", after: "settles" },
    ],
    expect: {
      lifecycle: "closed",
      closedBecause: "stopped",
      optedIn: false,
      receivedCount: { stop_ack: 1, reply: 0 },
      retainedParticipantText: [
        "5 πάντως. μη μου ξαναστείλετε μηνύματα παρακαλώ",
      ],
    },
  },

  // ── Gaps noticed while reading the existing 75 ────────────────────────────
  {
    // Materializer unit tests cover human-control STOP; the loop suite did not.
    // Consent decisions must work whichever writer holds the thread.
    id: "stop_while_staff_holds_control",
    title: "honours ΣΤΟΠ and withdraws consent while a human holds control",
    seed: { control: "human" },
    steps: [{ kind: "inbound", text: "ΣΤΟΠ" }],
    expect: {
      ...STOPPED,
      control: "human",
    },
  },
  {
    // Two consecutive permanent failures during a provider outage: each run still
    // files operator evidence, but the participant hears the canned apology once.
    id: "one_fallback_ack_across_consecutive_dead_runs",
    title:
      "speaks one deterministic fallback acknowledgement across consecutive dead runs",
    script: [{ fails: "refuses" }],
    expectedJobFailures: [
      { job: "feedback.extract.v1", kind: "refuses", count: 10 },
    ],
    steps: [
      { kind: "inbound", text: "ήταν όλα καλά" },
      { kind: "wait", after: "settles" },
      { kind: "inbound", text: "και η βραδιά ήταν τέλεια" },
      { kind: "wait", after: "settles" },
    ],
    expect: {
      notes: [
        { type: "general", about: null },
        { type: "general", about: null },
      ],
      needsAttention: true,
      receivedCount: { fallback: 1 },
    },
  },
];

runFeedbackScenarios("post-event feedback loop — edge seams", SCENARIOS);
