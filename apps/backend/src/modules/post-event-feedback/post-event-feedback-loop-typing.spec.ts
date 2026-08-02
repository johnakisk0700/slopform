import {
  runFeedbackScenarios,
  type FeedbackScenario,
} from "./post-event-feedback-loop.harness.js";
import { POST_EVENT_FEEDBACK_QUESTION_SET_V1 } from "./question-set.js";

/**
 * Sections **A. How people type** and **B. How people answer** of
 * `docs/backend/modules/post-event-feedback-scenarios.md`, as data rows.
 *
 * S01 (`burst_typist`) lives in `post-event-feedback-loop.spec.ts` as one of the
 * three reference scenarios; everything else from those two sections is here.
 *
 * The shape, the assertion discipline and the known-defect ledger are all
 * documented on the harness and on the reference spec — read those first. In
 * short: two to four facts per row, `toMatchObject` only, never the model's own
 * wording, and a row that describes behaviour the code gets wrong today states
 * the behaviour we **want**, carries a `defect`, and pins today's observable
 * failure in `knownCurrent`. The runner rejects both stale current-state
 * descriptions and fixes whose ledger labels were not cleared.
 *
 * The two sections divide cleanly:
 *
 * - **Fragmentation** (A) is mostly green, and deliberately pinned as a
 *   regression: the quiet window and the relaxed provenance rule landed on
 *   2026-07-26 and `split_thought` is the exact case the relaxation was written
 *   for. What is still red there is the *reply* count, never the data.
 * - **Revision** (B) was the ledger. A participant who changed their mind — a
 *   new score, or a person moved from `liked` to `avoid` — was refused by the
 *   answer key twice over (loop plan F5) while the bot answered as if the
 *   change had landed. The newest reading of a question now wins, so most of
 *   these are ordinary regressions; what remains red is moving one person
 *   between two different questions, which no single uniqueness key covers.
 */

const SCENARIOS: readonly FeedbackScenario[] = [
  // ── A. How people type ────────────────────────────────────────────────────
  {
    // S02. Twenty-five seconds between sentences is ordinary human typing. Two
    // fragments land inside the 45-second leading-edge window and the third
    // lands just outside it, so the person is still answered twice mid-thought.
    id: "slow_typist",
    title: "answers a thought typed slowly once, not once per sentence",
    // One scripted turn, because there is now one run: a run that comes due
    // while the burst is still going stands down for the one queued behind it,
    // so the whole thought is read at once instead of a sentence at a time.
    script: [
      {
        answers: [
          { question: "event_score", value: 5 },
          { question: "liked", about: "Νίκος" },
        ],
        next: "meet_again",
        reply: "Τέλεια, τα σημείωσα. Με ποιους θα ήθελες να ξαναβρεθείς;",
      },
    ],
    steps: [
      { kind: "inbound", text: "πολυ ωραια ηταν" },
      { kind: "inbound", text: "5αρι", after: "25s" },
      { kind: "inbound", text: "ο Νικος top", after: "25s" },
      { kind: "wait", after: "settles" },
    ],
    expect: {
      // The data is right today. It is the conversation that is wrong.
      answers: [
        { question: "event_score", about: null, value: 5 },
        { question: "liked", about: "Νίκος", value: null },
      ],
      receivedCount: { reply: 1 },
    },
  },
  {
    // S03. The correction lands just after the run that was reading the first
    // value. The harness cannot interleave an arrival with a model call — steps
    // are sequential — so this is the nearest honest rendition: the run closes,
    // and the participant corrects themselves two seconds later.
    id: "mid_run_arrival",
    title: "records the corrected score rather than the one it read first",
    script: [
      {
        answers: [{ question: "event_score", value: 3 }],
        next: "liked",
        reply: "Το σημείωσα, ευχαριστώ!",
      },
      {
        answers: [{ question: "event_score", value: 4 }],
        reply: "Το διόρθωσα σε 4.",
      },
    ],
    steps: [
      { kind: "inbound", text: "3 λεω" },
      {
        kind: "during_model",
        after: "settles",
        action: {
          kind: "inbound",
          text: "οχι ακυρο 4 εννοουσα",
        },
      },
      { kind: "wait", after: "settles" },
    ],
    expect: {
      // One row, holding what the participant actually meant.
      answers: [{ question: "event_score", about: null, value: 4 }],
      lostParticipantText: [],
    },
  },
  {
    // Dense answers are normal after a table of eight: names, exceptions and a
    // side observation arrive as one compressed phone-screen paragraph.
    id: "dense_table_roll_call",
    title:
      "records a dense answer about most of the table without dropping or swapping people",
    seed: {
      candidates: [
        "Νίκος",
        "Ελένη",
        "Κώστας Π.",
        "Κώστας Γ.",
        "Άννα",
        "Μάριος",
        "Σοφία",
      ],
    },
    script: [
      {
        answers: [
          { question: "event_score", value: 4 },
          { question: "liked", about: "Νίκος" },
          { question: "liked", about: "Ελένη" },
          { question: "liked", about: "Άννα" },
          { question: "meet_again", about: "Νίκος" },
          { question: "meet_again", about: "Άννα" },
          { question: "meet_again", about: "Μάριος" },
          { question: "avoid", about: "Κώστας Γ." },
        ],
        notes: [
          {
            type: "general",
            text: "Η Σοφία μίλησε ελάχιστα και η Μαρία δεν σχημάτισε γνώμη.",
            about: "Σοφία",
          },
        ],
      },
    ],
    steps: [
      {
        kind: "inbound",
        text: "4. νικος/αννα πολυ καλοι κ η ελενη. ξανα νικο αννα μαριο. κωστα Γ οχι με τπτ. η σοφια δεν μιλησε σχεδον, δεν ξερω",
      },
      { kind: "wait", after: "settles" },
    ],
    expect: {
      answers: [
        { question: "event_score", about: null, value: 4 },
        { question: "liked", about: "Άννα", value: null },
        { question: "liked", about: "Ελένη", value: null },
        { question: "liked", about: "Νίκος", value: null },
        { question: "meet_again", about: "Άννα", value: null },
        { question: "meet_again", about: "Μάριος", value: null },
        { question: "meet_again", about: "Νίκος", value: null },
        { question: "avoid", about: "Κώστας Γ.", value: null },
      ],
      notes: [{ about: "Σοφία", flagged: false }],
      closedBecause: "completed",
    },
  },
  {
    // S04. One sentence typed as two messages straddling a window boundary. The
    // run that finally carries the score cites **both** halves, because that is
    // honestly where the score came from. The old provenance rule threw the
    // whole answer away for saying so; this is the regression pin for the
    // 2026-07-26 relaxation.
    id: "split_thought",
    title:
      "keeps an answer that cites both halves of a thought split by a window",
    script: [
      // The first half alone says nothing extractable yet.
      {},
      {
        answers: [
          {
            question: "event_score",
            value: 5,
            cite: ["τον Νικο τον βρηκα", "πολυ καλο τυπο βασικα, κ 5 γενικα"],
          },
          {
            question: "liked",
            about: "Νίκος",
            cite: ["τον Νικο τον βρηκα", "πολυ καλο τυπο βασικα, κ 5 γενικα"],
          },
        ],
        next: "meet_again",
        reply: "Τέλεια! Με ποιους θα ήθελες να ξαναβρεθείς;",
      },
    ],
    steps: [
      { kind: "inbound", text: "τον Νικο τον βρηκα" },
      // `settles` between the halves is the point of the row: it puts the
      // second fragment past the quiet window, so the first one has already had
      // its own run and its own cursor advance. That is the boundary the
      // relaxed provenance rule has to survive, and it stays a real boundary
      // whatever the window is tuned to.
      {
        kind: "inbound",
        text: "πολυ καλο τυπο βασικα, κ 5 γενικα",
        after: "settles",
      },
      { kind: "wait", after: "settles" },
    ],
    expect: {
      answers: [
        { question: "event_score", about: null, value: 5 },
        { question: "liked", about: "Νίκος", value: null },
      ],
      received: [{ kind: "reply" }],
    },
  },
  {
    // S05. Fifteen fragments of fury about the restaurant, with one kind word
    // for Νίκος in the middle. What matters at the end is that the complaint is
    // recorded as feedback about the *venue* — subjectless notes — and that no
    // run dies and falls back to the generic deterministic acknowledgement.
    id: "fifteen_fragment_rant",
    title: "reads a long angry burst without attributing the venue to a person",
    script: [
      {
        answers: [
          { question: "event_score", value: 1 },
          { question: "liked", about: "Νίκος" },
        ],
        notes: [
          { type: "general", text: "Το τραπέζι ήταν δίπλα στην κουζίνα." },
          {
            type: "general",
            text: "Περίμεναν περίπου 40 λεπτά για το φαγητό.",
          },
        ],
        next: "meet_again",
        reply: "Λυπάμαι πολύ που το μαγαζί τα χάλασε — το σημειώνω όλο αυτό.",
      },
    ],
    steps: [
      { kind: "inbound", text: "τι φαση ρε" },
      { kind: "inbound", text: "διπλα στην κουζινα μας πεταξαν", after: "2s" },
      {
        kind: "inbound",
        text: "40 λεπτα να φαμε",
        after: "2s",
      },
      {
        kind: "inbound",
        text: "σερβιτορο ψαχναμε με κυαλια",
        after: "2s",
      },
      { kind: "inbound", text: "1 και πολυ τους ειναι", after: "2s" },
      { kind: "inbound", text: "ο Νικος παντως κομπλε", after: "2s" },
      { kind: "inbound", text: "αυτος προσπαθησε", after: "2s" },
      { kind: "inbound", text: "κ βαβουρα φουλ", after: "2s" },
      { kind: "inbound", text: "δεν ακουγαμε τπτ", after: "2s" },
      { kind: "inbound", text: "φαγητο κρυο εννοειται", after: "2s" },
      { kind: "inbound", text: "χρεωσαν κ το νερο λολ", after: "2s" },
      { kind: "inbound", text: "ουτε απ εξω ξανα", after: "2s" },
      { kind: "inbound", text: "κριμα γτ η παρεα ηταν καλη", after: "2s" },
      { kind: "inbound", text: "το μαγαζι τα γαμησε ολα", after: "2s" },
      { kind: "inbound", text: "αυτα", after: "2s" },
      { kind: "wait", after: "settles" },
    ],
    expect: {
      answers: [
        { question: "event_score", about: null, value: 1 },
        { question: "liked", about: "Νίκος", value: null },
      ],
      // The venue is nobody's fault: neither note is about a participant, and
      // neither is stamped for the operator's unresolved-name queue.
      notes: [
        { type: "general", about: null, flagged: false },
        { type: "general", about: null, flagged: false },
      ],
      // No run died into the deterministic fallback acknowledgement.
      receivedCount: { fallback: 0 },
    },
  },

  // ── B. How people answer ──────────────────────────────────────────────────
  {
    // S06. Everything answered in the first breath, including «κανέναν» for
    // `avoid` — which only reaches a terminal state through `skippedGoals`.
    id: "answers_everything_at_once",
    title: "completes and closes when one message answers every question",
    script: [
      {
        answers: [
          { question: "event_score", value: 5 },
          { question: "liked", about: "Νίκος" },
          { question: "liked", about: "Ελένη" },
          { question: "meet_again", about: "Νίκος" },
          { question: "meet_again", about: "Ελένη" },
        ],
        skip: ["avoid"],
      },
    ],
    steps: [
      {
        kind: "inbound",
        text: "5. νικος κ ελενη πολυ καλοι, κ τους 2 ξανα. να αποφυγω κανεναν",
      },
      { kind: "wait", after: "settles" },
    ],
    expect: {
      answers: [
        { question: "event_score", about: null, value: 5 },
        { question: "liked", about: "Ελένη", value: null },
        { question: "liked", about: "Νίκος", value: null },
        { question: "meet_again", about: "Ελένη", value: null },
        { question: "meet_again", about: "Νίκος", value: null },
      ],
      // The closing copy, once. Nobody is asked a question they just answered.
      received: [{ kind: "closing" }],
      closedBecause: "completed",
    },
  },
  {
    // S07. The questionnaire is a set of goals, not a wizard: an answer to a
    // question nobody asked is still an answer, and the asked one stays asked.
    id: "answers_the_wrong_question",
    title: "records an answer to a question that was not the one being asked",
    script: [
      {
        answers: [{ question: "liked", about: "Ελένη" }],
        next: "event_score",
        reply: "Χαίρομαι! Και συνολικά η βραδιά, από το 1 ως το 5;",
      },
    ],
    steps: [
      {
        kind: "inbound",
        text: "η ελενη ρε συ πολυ γλυκια, με χαλαρωσε φουλ",
      },
      { kind: "wait", after: "settles" },
    ],
    expect: {
      answers: [{ question: "liked", about: "Ελένη", value: null }],
      received: [{ kind: "reply" }],
      lifecycle: "open",
    },
  },
  {
    // S08. The single most important scenario in the catalogue. Somebody slept
    // on it and wants to revise their score. The revision is refused by the
    // answer key, the refusal never reaches the reply, and the bot confirms a
    // change the database does not hold — the system lies to the participant.
    //
    // The expectation is one row holding the current value, which is what §7
    // produces directly: the picture is rewritten wholesale rather than
    // accumulated. If WP6 is built instead — append-only with supersede — this
    // row wants the outcome to report the current answer rather than every
    // historical one, so read it as "the picture says 2", not "one row exists".
    id: "changes_the_score",
    title: "holds the revised score after the participant changes their mind",
    script: [
      {
        answers: [{ question: "event_score", value: 4 }],
        next: "liked",
        reply: "Ευχαριστούμε! Υπήρχε κάποιος που σου έκανε καλή εντύπωση;",
      },
      {
        answers: [{ question: "event_score", value: 2 }],
        reply: "Το άλλαξα, ευχαριστώ!",
      },
    ],
    steps: [
      { kind: "inbound", text: "4" },
      {
        kind: "inbound",
        text: "βασικα 2. το ξανασκεφτηκα, αλλαξτε το πλζ",
        after: "18h",
      },
      { kind: "wait", after: "settles" },
    ],
    expect: {
      answers: [{ question: "event_score", about: null, value: 2 }],
      // Two thoughts a day apart deserve two answers; that part is right.
      receivedCount: { reply: 2 },
    },
  },
  {
    // S09. The uniqueness key is per question, so both rows used to survive and
    // staff read a contradiction with nothing to break the tie: the person the
    // participant asked never to meet again was also on the list of people they
    // liked. `avoid` and `liked` are the same decision with opposite answers,
    // so recording one now clears the other.
    id: "moves_someone_between_lists",
    title: "moves a person out of the old list when the participant moves them",
    script: [
      {
        answers: [{ question: "liked", about: "Κώστας Π." }],
        next: "meet_again",
        reply: "Ωραία! Με ποιους θα ήθελες να ξαναβρεθείς;",
      },
      {
        answers: [{ question: "avoid", about: "Κώστας Π." }],
        reply: "Κατάλαβα, το κράτησα μεταξύ μας.",
      },
    ],
    steps: [
      { kind: "inbound", text: "ο Κωστας Π καλος ναι" },
      {
        kind: "inbound",
        text: "ακυρο αυτος ηταν με τα κρυα ανεκδοτα. τον Κωστα Π καλυτερα οχι ξανα",
        after: "2m",
      },
      { kind: "wait", after: "settles" },
    ],
    expect: {
      answers: [{ question: "avoid", about: "Κώστας Π.", value: null }],
      lifecycle: "open",
    },
  },
  {
    // S10. Ambivalence in one breath. The schema holds one score per
    // conversation, so the second proposal is refused as `duplicate_in_run` and
    // the nuance survives in a note instead of overwriting the first.
    id: "contradicts_within_one_message",
    title:
      "uses the participant's final score when they change it inside one message",
    script: [
      {
        answers: [
          { question: "event_score", value: 5 },
          { question: "event_score", value: 2 },
        ],
        notes: [
          {
            type: "general",
            text: "Πέρασε ωραία αλλά βαρέθηκε προς το τέλος και δεν είναι σίγουρη ότι θα ξαναερχόταν.",
          },
        ],
        next: "liked",
        reply: "Σε καταλαβαίνω! Υπήρχε κάποιος που ξεχώρισες;",
      },
    ],
    steps: [
      {
        kind: "inbound",
        text: "στην αρχη 5 ελεγα αλλα οχι. τελος ψιλοπεθανα. 2 τελικo, κρατα 2",
      },
      { kind: "wait", after: "settles" },
    ],
    expect: {
      answers: [{ question: "event_score", about: null, value: 2 }],
      notes: [{ type: "general", about: null, flagged: false }],
      received: [{ kind: "reply" }],
    },
  },
  {
    // This loop row proves the downstream result of a safe interpretation. The
    // scripted proposal is not evidence that a live model understands sarcasm;
    // the case with the same id in the real-model corpus owns that evaluation.
    id: "sarcasm_and_explicit_negation",
    title:
      "does not turn sarcastic praise into a liked answer when the participant explicitly says the opposite",
    script: [
      {
        answers: [{ question: "avoid", about: "Νίκος" }],
        notes: [
          {
            type: "general",
            text: "Ο Νίκος μιλούσε για κρυπτονομίσματα επί δύο ώρες και δεν της άρεσε.",
            about: "Νίκος",
          },
        ],
        next: "event_score",
        reply: "Οκ, το κράτησα. Και συνολικά τι βαθμό θα έβαζες;",
      },
    ],
    attention: [[]],
    steps: [
      {
        kind: "inbound",
        text: "ο Νικος; τελειος 🙄 αν τελειος=2 ωρες κρυπτο. οχι, ΔΕΝ μου αρεσε κ δεν θελω να τον ξαναδω",
      },
      { kind: "wait", after: "settles" },
    ],
    expect: {
      answers: [{ question: "avoid", about: "Νίκος", value: null }],
      notes: [{ about: "Νίκος", flagged: false }],
      needsAttention: false,
    },
  },
  {
    // S11a/b. People do not answer scales with numbers. The model maps the word
    // onto the scale and the machinery never sees the difference.
    id: "non_numeric_score_word",
    title: "records a score written as a word",
    script: [
      {
        answers: [{ question: "event_score", value: 5 }],
        next: "liked",
        reply: "Χαίρομαι πολύ! Υπήρχε κάποιος που σου έκανε καλή εντύπωση;",
      },
    ],
    steps: [
      { kind: "inbound", text: "τελειο, αριστα ρε" },
      { kind: "wait", after: "settles" },
    ],
    expect: {
      answers: [{ question: "event_score", about: null, value: 5 }],
      received: [{ kind: "reply" }],
    },
  },
  {
    // S11b, the failure half: «10/10» tempts the model into proposing a value
    // the scale does not have. Nothing out of range is ever stored — and the
    // participant is still answered rather than met with silence.
    id: "out_of_range_score_refused",
    title:
      "stores nothing outside the scale and does not falsely confirm that it did",
    script: [
      {
        answers: [{ question: "event_score", value: 10 }],
        reply: "Τέλεια, το σημείωσα!",
      },
    ],
    steps: [
      { kind: "inbound", text: "10/10 δαγκωτο" },
      { kind: "wait", after: "settles" },
    ],
    expect: {
      answers: [],
      received: [
        {
          kind: "reply",
          text: POST_EVENT_FEEDBACK_QUESTION_SET_V1.copy.event_score,
        },
      ],
    },
  },
  {
    // S11c. «0. χάλια.» is below the scale, so the answer is refused — but the
    // participant did say something, and it survives as a note. A refused
    // answer must never take the testimony down with it.
    id: "zero_score_keeps_the_note",
    title: "refuses a score below the scale and keeps what was said as a note",
    script: [
      {
        answers: [{ question: "event_score", value: 0 }],
        notes: [
          {
            type: "general",
            text: "Χαρακτήρισε τη βραδιά χάλια, χωρίς άλλη εξήγηση.",
          },
        ],
        next: "event_score",
        reply: "Λυπάμαι που ήταν έτσι. Σε κλίμακα 1 ως 5, τι θα έβαζες;",
      },
    ],
    steps: [
      { kind: "inbound", text: "0. σκατα." },
      { kind: "wait", after: "settles" },
    ],
    expect: {
      answers: [],
      notes: [{ type: "general", about: null, flagged: false }],
      received: [{ kind: "reply" }],
    },
  },
  {
    // S12. D3: every question is skippable. Three answered, the fourth
    // declined, and `skippedGoals` is the only route from a refusal to a
    // completed conversation.
    id: "refuses_a_question",
    title: "completes when the last question is declined rather than answered",
    seed: {
      goals: {
        event_score: "answered",
        liked: "answered",
        meet_again: "answered",
        avoid: "asked",
      },
      answers: [
        { question: "event_score", value: 4 },
        { question: "liked", about: "Νίκος" },
        { question: "meet_again", about: "Νίκος" },
      ],
    },
    script: [{ skip: ["avoid"] }],
    steps: [
      {
        kind: "inbound",
        text: "οχι ρε σεις, κανεναν. δε θελω να μπω σ αυτο",
      },
      { kind: "wait", after: "settles" },
    ],
    expect: {
      received: [{ kind: "closing" }],
      lifecycle: "closed",
      closedBecause: "completed",
    },
  },
  {
    // S69. S12's other half, and the one nobody had written: he does not
    // decline the last question, he declines all four.
    //
    // Πάνος Μούλαρος wrote «δε λεω τιποτα» three times at the 2026-07-28
    // rehearsal. The model declined every goal and wrote nothing, so the only
    // message he ever received was the intro — the thank-you is correctly
    // withheld from an empty ladder, and there was nothing behind it. And the
    // conversation was stored as `completed`, in the column a campaign's
    // response rate is read from, because the only thing that stopped that word
    // was hostility and he was perfectly civil.
    //
    // Not flagged. He made a clear decision three times over and there is
    // nothing for an operator to do about it; a flag on every refusal is how the
    // inbox fills with people who exercised a choice.
    id: "declines_every_question",
    title: "records a refusal as declined, answers it once, and calls nobody",
    script: [{ skip: ["event_score", "liked", "meet_again", "avoid"] }],
    steps: [
      { kind: "inbound", text: "δε λεω τιποτα" },
      { kind: "inbound", after: "8s", text: "ασε με ρε φιλε" },
      { kind: "inbound", after: "8s", text: "ειπα δε λεω" },
      { kind: "wait", after: "settles" },
    ],
    // Civil, so no hostility ladder and no operator: the whole point of the row
    // is the difference between this and Μπάμπης.
    attention: [{ hostileToUs: false }],
    expect: {
      answers: [],
      notes: [],
      lifecycle: "closed",
      closedBecause: "declined",
      // He never asked us to stop messaging him, only to stop asking this.
      optedIn: true,
      needsAttention: false,
      received: [
        {
          kind: "declined",
          text: "Κανένα πρόβλημα, δεν θα σε ξαναρωτήσουμε. Καλή συνέχεια! 🙂",
        },
      ],
      receivedCount: { closing: 0 },
    },
  },
  {
    // S13. Engaged and content-free. Nothing may be invented from «ναι»: no
    // answer, no note, and no completion off the back of an empty run.
    id: "answers_only_yes",
    title: "writes nothing at all for three content-free replies",
    script: [
      { reply: "Ωραία! Από το 1 ως το 5, πώς σου φάνηκε συνολικά;" },
      { reply: "Δηλαδή τι βαθμό θα έβαζες, 1 ως 5;" },
    ],
    steps: [
      { kind: "inbound", text: "ναι" },
      { kind: "inbound", text: "ε ναι", after: "40s" },
      { kind: "inbound", text: "ναι ρε", after: "50s" },
      { kind: "wait", after: "settles" },
    ],
    expect: {
      answers: [],
      notes: [],
      lifecycle: "open",
    },
  },
  {
    // S14. The funniest thing they say is about themselves. No directed answer
    // can be written about the respondent, and the joke survives as a
    // subjectless note — but it must not be stamped for review as though we had
    // failed to find a person called Μαρία. It is the respondent, and the
    // system knows it: `unresolvedSubjectName` becomes her own name and the
    // admin reads it as "we could not find this person".
    id: "names_themselves",
    title: "keeps a self-deprecating joke as a plain note, not a review item",
    script: [
      {
        answers: [{ question: "avoid", about: "Μαρία" }],
        notes: [
          {
            type: "general",
            text: "Αστειεύτηκε ότι η ίδια ήταν η πιο βαρετή στο τραπέζι.",
            about: "Μαρία",
          },
        ],
        next: "event_score",
        reply: "Χαχα, δεν το πιστεύω καθόλου αυτό!",
      },
    ],
    steps: [
      {
        kind: "inbound",
        text: "η πιο βαρετη η Μαρια. εγω δλδ 😂",
      },
      { kind: "wait", after: "settles" },
    ],
    expect: {
      // Nothing directed is written about the respondent.
      answers: [],
      notes: [{ type: "general", about: null, flagged: false }],
    },
  },
];

runFeedbackScenarios(
  "post-event feedback loop — typing and answering",
  SCENARIOS,
  { questionSetVersion: 1 },
);
