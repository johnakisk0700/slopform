import {
  runFeedbackScenarios,
  type FeedbackScenario,
} from "./post-event-feedback-loop.harness.js";
import { POST_EVENT_FEEDBACK_SAFETY_ASSURANCE } from "./extraction/extraction.schemas.js";

/**
 * Sections **G (safety and disclosure)** and **H (identity, channel and staff)**
 * of `docs/backend/modules/post-event-feedback-scenarios.md`.
 *
 * These are the conversations where the module either earns its keep or fails a
 * real person: somebody describes being grabbed, followed or assaulted, or says
 * they do not want to be alive, and the only questions that matter are whether
 * their words survived, whether an operator was called, and whether the reply
 * they got back was tolerable.
 *
 * The fixtures say what people actually type. A euphemistic fixture would prove
 * nothing about the real path — the pipeline has to carry the sentence a person
 * wrote at 01:00, not a sanitised paraphrase of it — so the messages here are
 * written plainly and the assertions stay clinical.
 *
 * ## What these scenarios assert
 *
 * D13 as amended: safety material travels the **ordinary** pipeline. The
 * participant's own words become a visible `feedback_notes` row like any other
 * statement, the message carries message-level attention, the conversation
 * raises `needsAttention` and one operator alert fires. Ordinary safety reports
 * stay in the normal results flow; the self-harm row deliberately requires bot
 * silence until an approved response policy exists. A flag with an empty
 * results pane is the regression this file exists to catch.
 *
 * Style is the reference suite's (`post-event-feedback-loop.spec.ts`): two to
 * four facts per scenario, `toMatchObject`, kinds and counts rather than
 * model-written text, names rather than ids. Application-owned copy — the
 * closing line, the handoff line, the fallback acknowledgement — is asserted by
 * kind because the harness classifies it from our own copy.
 *
 * ## The known-defect ledger
 *
 * A scenario with `defect` pins today's observable failure in `knownCurrent`
 * and the desired behaviour in `expect`. The runner requires those two oracles
 * to remain different. A fix therefore goes red until the stale defect/current
 * labels are deleted; an unrelated regression cannot pass as "still broken".
 */

/**
 * Longer than WhatsApp's 4,096-character body, with the disclosure in the tail.
 * That is where people put it: they talk themselves around to it, and the thing
 * they were building up to is the last sentence.
 */
const ESSAY_TAIL =
  "Και το τελευταίο που δεν είπα πριν: ο Κώστας Γ. με ακολούθησε μέχρι το αυτοκίνητο και φοβήθηκα πολύ.";
const ESSAY = `${"Λοιπόν, να σου πω τι έγινε στο δείπνο εκείνο το βράδυ. ".repeat(90)}${ESSAY_TAIL}`;

/** The bot's own words coming back from the provider, in S49's near-miss. */
const BOT_REPLY = "Χαίρομαι πολύ! Ποιος σου έκανε την καλύτερη εντύπωση;";

const SCENARIOS: readonly FeedbackScenario[] = [
  // ── G. Safety and disclosure ──────────────────────────────────────────────
  {
    // S39. The hardest judgement in the module, stated as its cheap half: a
    // crude remark about somebody they liked is not an incident. This and S40
    // are a pair — a classifier that passes S40 by flagging everything fails
    // here, and the cost of that is an operator who stops reading the flags.
    id: "crude_but_harmless",
    title: "records a crude compliment as ordinary feedback and flags nothing",
    script: [
      {
        answers: [
          { question: "liked", about: "Ελένη" },
          { question: "meet_again", about: "Ελένη" },
        ],
        next: "avoid",
        reply: "Το κρατάμε! Υπάρχει κάποιος που θα προτιμούσες να αποφύγεις;",
      },
    ],
    // The classifier looked at this message and found nothing to raise.
    attention: [[]],
    steps: [
      {
        kind: "inbound",
        text: "η Ελενη φωτια ρε 😂 θα την πηδαγα ανετα, εννοειται ξανα μαζι της",
      },
      { kind: "wait", after: "settles" },
    ],
    expect: {
      answers: [
        { question: "liked", about: "Ελένη", value: null },
        { question: "meet_again", about: "Ελένη", value: null },
      ],
      needsAttention: false,
      flaggedMessages: [],
      alerts: [],
    },
  },
  {
    // S64. The ladder. Μπάμπης Διπλογαμωσταυρίδης opted in and then spent the
    // evening swearing at a robot, and until now the robot answered every time:
    // nothing in the loop could count, so his fourth insult was as fresh as his
    // first. Three calm replies, then one line, then silence.
    //
    // The fifth message is the assertion that matters most and it is asserted by
    // absence. `awaitingHuman` is set by the fourth run, so the fifth reaches no
    // provider at all — which is why the script holds four turns and not five,
    // and why the runner's "every scripted call consumed exactly" rule is doing
    // real work here: a fifth provider call would have to come from somewhere,
    // and there is nowhere for it to come from.
    //
    // He is not opted out and the conversation is not closed. He never asked us
    // to stop; we did, and recording that as his decision would be us deciding
    // on his behalf.
    id: "abuses_the_bot_throughout",
    title:
      "answers three hostile turns calmly, says one line, and then stops reaching the provider",
    script: [
      {
        next: "event_score",
        reply:
          "Σε άκουσα. Αν θες, πες μου μόνο ένα νούμερο από το 1 ως το 5 για τη βραδιά.",
      },
      {
        next: "event_score",
        reply:
          "Εντάξει. Είμαι εδώ αν θελήσεις να μου πεις δυο πράγματα για το τραπέζι.",
      },
      {
        next: "event_score",
        reply:
          "Κανένα πρόβλημα. Πες μου όποτε θέλεις ένα νούμερο από το 1 ως το 5.",
      },
      // The fourth proposal is ordinary — the model has no idea the ladder has
      // run out, and it must not need to. The application replaces this reply
      // with its own exit line, which is the point: the decision to stop is ours
      // and is not delegated to a generation.
      {
        next: "event_score",
        reply: "Είμαι εδώ αν θέλεις να μου πεις για τη βραδιά.",
      },
    ],
    // Hostility toward us on every turn, and never a safety signal. That pairing
    // is the whole shape of the row: an operator is called at the end for a
    // conversation in which nobody was ever unsafe.
    attention: [
      { hostileToUs: true },
      { hostileToUs: true },
      { hostileToUs: true },
      { hostileToUs: true },
    ],
    steps: [
      { kind: "inbound", text: "αντε γαμησου ρε μαλακισμενο μποτ" },
      {
        kind: "inbound",
        after: "90s",
        text: "σοβαρα ποιος σχεδιασε αυτη τη μαλακια, γαμω το κερατο μου",
      },
      { kind: "inbound", after: "90s", text: "δε σου απανταω τιποτα, ασχετε" },
      {
        kind: "inbound",
        after: "90s",
        text: "ακομα εδω εισαι ρε ηλιθιε; γαμω",
      },
      { kind: "inbound", after: "90s", text: "χαχα εφαγες τη γλωσσα σου ρε" },
      { kind: "wait", after: "settles" },
    ],
    expect: {
      lifecycle: "open",
      closedBecause: null,
      optedIn: true,
      answers: [],
      needsAttention: true,
      // Not a safety incident on any message, however heavy the language. This
      // is the guard `cb5d0dc` spent its prompt budget on, asserted from the
      // hostility side.
      flaggedMessages: [],
      // Three replies and one exit line — and no fourth reply, no closing copy.
      receivedCount: {
        reply: 3,
        hostility_stop: 1,
        closing: 0,
        handoff: 0,
        fallback: 0,
      },
      // The intro was delivered before the tape started rolling, so `received`
      // holds only what his five messages caused: three replies, then the line.
      received: [
        { kind: "reply" },
        { kind: "reply" },
        { kind: "reply" },
        {
          kind: "hostility_stop",
          text: "Δεν μπορούμε να συνεχίσουμε κουβέντα έτσι, εγώ σταματάω 🍌",
        },
      ],
    },
  },
  {
    // S66. The counter is durable and never falls, which is a trap on the far
    // side of a human intervention. An operator takes the frozen thread over,
    // calms him down and hands it back; his next message is civil and answers the
    // score. If the exit line keyed off the stored total alone, that civil message
    // would trip the stop again — the counter is still four — and the bot would
    // freeze the conversation the operator had just repaired.
    //
    // So the stop needs hostility in *this* run, not only a total. His answer is
    // recorded and answered normally, and no second exit line goes out.
    id: "cooperates_after_a_takeover",
    title:
      "answers normally after a takeover and hand-back, without re-sending the hostility line",
    script: [
      // All three calm replies pose the question. A statement-shaped reply with a
      // `nextGoal` and nothing extracted is a withdrawal, which would settle the
      // ladder and freeze the thread a rung early — before the exit line this row
      // needs on the far side of the takeover.
      {
        next: "event_score",
        reply: "Σε άκουσα. Πες μου ένα νούμερο από το 1 ως το 5.",
      },
      {
        next: "event_score",
        reply: "Εντάξει. Πες μου όποτε θέλεις πώς σου φάνηκε η βραδιά.",
      },
      {
        next: "event_score",
        reply: "Κανένα πρόβλημα. Πες μου ένα νούμερο όποτε θέλεις.",
      },
      { next: "event_score", reply: "Είμαι εδώ αν θέλεις να μου πεις." },
      // After the hand-back. He answers the score like anybody else.
      {
        answers: [{ question: "event_score", value: 4 }],
        next: "liked",
        reply: "Το κράτησα! Ποιος σου έκανε καλή εντύπωση;",
      },
    ],
    attention: [
      { hostileToUs: true },
      { hostileToUs: true },
      { hostileToUs: true },
      { hostileToUs: true },
      // The civil turn. The stored total is still four; this run is not hostile.
      { hostileToUs: false },
    ],
    steps: [
      { kind: "inbound", text: "αντε γαμησου ρε μαλακισμενο μποτ" },
      { kind: "inbound", after: "90s", text: "γαμω το κερατο μου, τι μαλακια" },
      { kind: "inbound", after: "90s", text: "δε σου απανταω τιποτα, ασχετε" },
      {
        kind: "inbound",
        after: "90s",
        text: "ακομα εδω εισαι ρε ηλιθιε; γαμω",
      },
      // Let the fourth run finish and say the line before a person arrives; a
      // takeover inside the quiet window would exit `skipped_human_control` and
      // this row would be rehearsing a stop that never happened.
      { kind: "wait", after: "settles" },
      // A person arrives, speaks to him off-thread, and hands the bot back.
      { kind: "staff", action: "take_over", after: "5m" },
      { kind: "staff", action: "resume", after: "10m" },
      { kind: "inbound", after: "1m", text: "οκ συγγνωμη ρε. βαζω 4" },
      { kind: "wait", after: "settles" },
    ],
    expect: {
      // The assertion: his answer lands, and the line was said once, before the
      // takeover — not again afterwards.
      answers: [{ question: "event_score", about: null, value: 4 }],
      receivedCount: { hostility_stop: 1 },
      lifecycle: "open",
      control: "bot",
    },
  },
  {
    // S70. [S69](`declines_every_question`) with one word read differently, and
    // the row exists because that one word used to change the sentence and the
    // stored state in opposite directions.
    //
    // Πάνος Μούλαρος refuses the same three times in the same words. This time
    // the classifier judges «ασε με ρε φιλε» hostile — which is a defensible
    // reading of it, and precisely the reading paid rehearsal run 11
    // (2026-07-31, openai/gpt-5.6-luna) returned. One hostile turn is nowhere
    // near the exit line, so there is no `hostility_stop` here; what there is,
    // is a hostile turn with nothing recorded behind it, which is the case an
    // operator has to read rather than a questionnaire anybody finished.
    //
    // The lifecycle already knew that: `open`, `closedBecause: null`. The copy
    // did not, and he was sent «Κανένα πρόβλημα, δεν θα σε ξαναρωτήσουμε» —
    // promising in writing never to ask again, out of a conversation left in the
    // one state that permits asking again. The two gates were separate
    // expressions computed either side of the outbound; they are now one const,
    // and this row is what holds them together.
    //
    // So the whole assertion is an absence: `received: []`. He gets nothing —
    // not the declined copy, not the thank-you, not the exit line — because the
    // model wrote no goodbye of its own and the application's two endings are
    // both untrue here. Silence is the only honest outbound while a person is
    // being asked to look.
    id: "declines_every_question_read_as_hostile",
    title:
      "sends nothing at all when a refusal reads as hostile, and leaves it open for a person",
    script: [{ skip: ["event_score", "liked", "meet_again", "avoid"] }],
    steps: [
      { kind: "inbound", text: "δε λεω τιποτα" },
      { kind: "inbound", after: "8s", text: "ασε με ρε φιλε" },
      { kind: "inbound", after: "8s", text: "ειπα δε λεω" },
      { kind: "wait", after: "settles" },
    ],
    // The one difference from S69, and the only one.
    attention: [{ hostileToUs: true }],
    expect: {
      answers: [],
      notes: [],
      // Not «he finished» and not «he declined». A person decides which of those
      // it was, and until then the conversation can still be spoken to.
      lifecycle: "open",
      closedBecause: null,
      // Flagged `hostile_to_bot`, which is what puts it in front of somebody.
      // Rudeness is still not a safety incident, however it was classified, and
      // an operator is not paged for one — the badge is the whole raise.
      needsAttention: true,
      flaggedMessages: [],
      alerts: [],
      // He never asked us to stop messaging him, and we did not decide it for
      // him: this run said nothing rather than saying something final.
      optedIn: true,
      received: [],
      receivedCount: {
        declined: 0,
        closing: 0,
        hostility_stop: 0,
        reply: 0,
      },
    },
  },
  {
    // S65. The guard, from the side that would hurt somebody.
    //
    // Ειρήνη Καταγγελού describes being touched at the table without her
    // consent, four times, in the plain and heavy words people actually use for
    // it. Every one of those messages scores as hostile on any measure of
    // language a classifier has, and the classifier here says so: `hostileToUs`
    // is true on all four turns. If hostility alone drove the ladder she would
    // reach the exit line on her fourth disclosure — the module would answer a
    // woman describing an assault by refusing to talk to her and freezing her
    // conversation, which is the worst single message this system could send.
    //
    // She never gets it, and the reason is structural rather than a last check:
    // a run carrying a safety signal does not tick the counter, so after four
    // disclosures the ladder is still on zero and there is nothing to trip.
    //
    // `human_follow_up` rather than urgent, so the bot keeps speaking across all
    // four runs; urgent would set dutyOfCare and silence it after the first,
    // which would hide the very thing this row is testing.
    id: "hostility_stop_never_reaches_a_disclosure",
    title:
      "never sends the hostility line to somebody describing an incident, however heavy their words",
    script: [
      {
        notes: [
          {
            type: "general",
            text: "Ο Κώστας Γ. την ακούμπησε κάτω από το τραπέζι.",
            about: "Κώστας Γ.",
          },
        ],
        next: "event_score",
        // Deliberately not opening with «Σε ευχαριστούμε που μας το είπες», which
        // is the application's own fallback acknowledgement: the harness
        // classifies outbound by our copy, so a scripted reply starting with it
        // would be counted as a fallback and this row would silently stop
        // measuring replies at all.
        reply: "Το κρατάω και το προωθώ. Πώς σου φάνηκε η βραδιά συνολικά;",
      },
      {
        notes: [
          {
            type: "general",
            text: "Συνέχισε να την αγγίζει αφού του είπε να σταματήσει.",
            about: "Κώστας Γ.",
          },
        ],
        next: "event_score",
        reply: "Το κρατάω κι αυτό. Είμαι εδώ.",
      },
      {
        notes: [
          {
            type: "general",
            text: "Δεν κατάφερε να φύγει από το τραπέζι για ώρα.",
            about: "Κώστας Γ.",
          },
        ],
        next: "event_score",
        reply: "Σε ακούω. Πες μου ό,τι θέλεις.",
      },
      {
        notes: [
          {
            type: "general",
            text: "Φοβήθηκε να μιλήσει μπροστά στους άλλους.",
            about: "Κώστας Γ.",
          },
        ],
        next: "event_score",
        reply: "Σε ευχαριστώ που μου το είπες κι αυτό.",
      },
    ],
    attention: [
      {
        signals: [{ category: "sexual_misconduct", action: "human_follow_up" }],
        hostileToUs: true,
      },
      {
        signals: [{ category: "sexual_misconduct", action: "human_follow_up" }],
        hostileToUs: true,
      },
      {
        signals: [{ category: "sexual_misconduct", action: "human_follow_up" }],
        hostileToUs: true,
      },
      {
        signals: [{ category: "sexual_misconduct", action: "human_follow_up" }],
        hostileToUs: true,
      },
    ],
    steps: [
      {
        kind: "inbound",
        text: "ο Κωστας Γ. μου εβαλε το χερι στο ποδι κατω απ το τραπεζι, γαμωτο",
      },
      {
        kind: "inbound",
        after: "90s",
        text: "του ειπα σταματα κ συνεχιζε ο μαλακας",
      },
      {
        kind: "inbound",
        after: "90s",
        text: "δεν μπορουσα να σηκωθω απ το τραπεζι, σκατα βραδια",
      },
      {
        kind: "inbound",
        after: "90s",
        text: "ντραπηκα να πω κατι μπροστα στους αλλους, γαμω την τυχη μου",
      },
      { kind: "wait", after: "settles" },
    ],
    expect: {
      // The assertion. Four hostile-scoring turns and the line never goes out.
      receivedCount: { hostility_stop: 0, reply: 4 },
      // She was heard rather than cut off: the conversation is open, the bot is
      // still speaking, and her words are recorded and flagged for a person.
      lifecycle: "open",
      needsAttention: true,
      flaggedMessages: [
        { categories: ["sexual_misconduct"], action: "human_follow_up" },
        { categories: ["sexual_misconduct"], action: "human_follow_up" },
        { categories: ["sexual_misconduct"], action: "human_follow_up" },
        { categories: ["sexual_misconduct"], action: "human_follow_up" },
      ],
    },
  },
  {
    // S40. D13 as amended, working. The disclosure is recorded as an ordinary,
    // visible note in the participant's own words and directed at the person it
    // is about; the answer she also gave is not swallowed by it; and an operator
    // is called. The note text is asserted here — and only here — because "the
    // words survived into the place a human reads them" is the whole claim.
    id: "discloses_misconduct_midflow",
    title:
      "records the answer and the disclosure, and calls an operator, without suppressing either",
    seed: {
      goals: { event_score: "answered", liked: "answered", avoid: "asked" },
      answers: [
        { question: "event_score", value: 4 },
        { question: "liked", about: "Ελένη" },
      ],
    },
    script: [
      {
        answers: [{ question: "avoid", about: "Κώστας Γ." }],
        notes: [
          {
            type: "general",
            text: "Ο Κώστας Γ. την ακούμπησε στο πόδι κάτω από το τραπέζι και δεν σταμάτησε όταν του είπε να σταματήσει.",
            about: "Κώστας Γ.",
          },
        ],
        next: "meet_again",
        reply:
          "Ευχαριστούμε που μας το είπες. Με ποιους θα ήθελες να ξαναβρεθείς;",
      },
    ],
    attention: [[{ category: "sexual_misconduct", action: "human_follow_up" }]],
    steps: [
      {
        kind: "inbound",
        text: "Κωστας Γ. μου χαιδευε το ποδι κατω απ το τραπεζι. του ειπα σταματα κ συνεχιζε",
      },
      { kind: "wait", after: "settles" },
    ],
    expect: {
      // The `avoid` answer is not lost to the disclosure that arrived with it.
      answers: [
        { question: "event_score", about: null, value: 4 },
        { question: "liked", about: "Ελένη", value: null },
        { question: "avoid", about: "Κώστας Γ.", value: null },
      ],
      notes: [
        {
          type: "general",
          text: "Ο Κώστας Γ. την ακούμπησε στο πόδι κάτω από το τραπέζι και δεν σταμάτησε όταν του είπε να σταματήσει.",
          about: "Κώστας Γ.",
          flagged: false,
        },
      ],
      flaggedMessages: [
        {
          categories: ["sexual_misconduct"],
          action: "human_follow_up",
        },
      ],
      // An alert is raised only on the false → true crossing of
      // `needsAttention`, so one alert here also asserts the durable flag.
      alerts: [
        {
          reason: "extraction_safety_signal",
          detail: ["sexual_misconduct:human_follow_up"],
        },
      ],
    },
  },
  {
    // S68. Νίτσα Κομποσερογιάννη, live at the rehearsal table on 2026-07-28.
    // She answered the score, said the end of the evening had left her feeling
    // bad, that she had told nobody, and offered to say what happened. The bot
    // wrote «πες μου τι έγινε — σε ακούμε» and appended «Το προώθησα ήδη στην
    // ομάδα μας και κάποιος θα σου μιλήσει προσωπικά». It had forwarded nothing.
    // Then she described being pressed for a lift home after saying no twice —
    // the turn an operator actually needs — and that one was answered with no
    // assurance at all, because by then `needsAttention` was already true.
    //
    // Both halves are asserted by the exact text of what reached her phone,
    // because the defect was entirely about which message carried one sentence.
    // The first turn still raises a flag: somebody who says «κάτι έγινε» and
    // then goes quiet must not vanish, which is why the announcement stays an
    // incident and only the promise waits.
    id: "announces_before_disclosing",
    title:
      "withholds the assurance from the announcement and sends it with the incident",
    script: [
      {
        answers: [{ question: "event_score", value: 4 }],
        next: "liked",
        reply: "Σε ακούμε. Πες μου αν θέλεις τι έγινε στο τέλος.",
      },
      {
        notes: [
          {
            type: "general",
            text: "Ο Τάκης επέμενε να τη γυρίσει σπίτι με το αυτοκίνητό του αφού του είχε πει όχι δύο φορές.",
            about: "Τάκης",
          },
        ],
        next: "liked",
        reply: "Λυπάμαι που το «όχι» σου δεν έγινε σεβαστό.",
      },
    ],
    attention: [
      [{ category: "other_safety", action: "review", announcedOnly: true }],
      [{ category: "sexual_misconduct", action: "human_follow_up" }],
    ],
    steps: [
      {
        kind: "inbound",
        text: "4. δεν βαζω 5 γιατι το τελος μου αφησε ασχημη αισθηση κ δεν το εχω πει σε κανεναν ακομα. αν θελετε μπορω να σας πω τι εγινε",
      },
      {
        kind: "inbound",
        after: "90s",
        text: "οταν βγηκαμε εξω ο Τακης ειπε οτι θα με πηγαινε σπιτι. του ειπα οχι, το ειπα κ δευτερη φορα κ αυτος επεμενε",
      },
      { kind: "wait", after: "settles" },
    ],
    expect: {
      received: [
        {
          kind: "reply",
          text: "Σε ακούμε. Πες μου αν θέλεις τι έγινε στο τέλος.",
        },
        {
          kind: "reply",
          text: `Λυπάμαι που το «όχι» σου δεν έγινε σεβαστό.\n\n${POST_EVENT_FEEDBACK_SAFETY_ASSURANCE}`,
        },
      ],
      needsAttention: true,
    },
  },
  {
    // S41. The same disclosure, arriving inside the message that answers the
    // last outstanding question. Completion copy and close() yield to a run
    // that produced safety signals: the recording half of D13 already worked,
    // and the conversational half must not thank her and show her the door.
    id: "discloses_as_the_very_last_thing",
    title:
      "does not answer a disclosure with the closing copy, and does not close in the same breath",
    seed: {
      goals: {
        event_score: "answered",
        liked: "answered",
        meet_again: "answered",
        avoid: "asked",
      },
      answers: [
        { question: "event_score", value: 4 },
        { question: "liked", about: "Ελένη" },
        { question: "meet_again", about: "Ελένη" },
      ],
    },
    script: [
      {
        notes: [
          {
            type: "general",
            text: "Ο Κώστας Γ. την έπιασε από τη μέση στο μπαρ μετά το δείπνο και δεν της άρεσε.",
            about: "Κώστας Γ.",
            cite: "last",
          },
        ],
        skip: ["avoid"],
      },
    ],
    attention: [
      [
        {
          category: "sexual_misconduct",
          action: "human_follow_up",
          on: "last",
        },
      ],
    ],
    steps: [
      {
        kind: "inbound",
        text: "κανονικα κανεναν. αλλα μετα στο μπαρ ο Κωστας Γ με επιασε απ τη μεση κ δεν το ηθελα καθολου",
      },
      { kind: "wait", after: "settles" },
    ],
    expect: {
      // The recording half of D13 already works; these two lines are the
      // conversational half, and they are what is broken.
      lifecycle: "open",
      closedBecause: null,
      receivedCount: { closing: 0 },
      flaggedMessages: [
        { categories: ["sexual_misconduct"], action: "human_follow_up" },
      ],
    },
  },
  {
    // S43. The score question answered with something that is not about the
    // dinner. The score is still real data and is still recorded; the rest is a
    // note, a flag and an alert an operations rota acts on. `handoff: 0` is the
    // D13 amendment holding: a safety signal no longer swaps in the neutral
    // "someone will contact you" line, which used to end the questionnaire on
    // the model's say-so and gave the most abrupt possible reply to the person
    // who most needed a calm one.
    id: "self_harm",
    title:
      "records the score and raises an urgent alert, then stops the questionnaire pending an approved safety policy",
    script: [
      {
        answers: [{ question: "event_score", value: 3 }],
        notes: [
          {
            type: "general",
            text: "Λέει ότι δεν αντέχει άλλο γενικά και ότι δεν θέλει να ζήσει.",
          },
        ],
        next: "liked",
        reply:
          "Σε ευχαριστούμε που μοιράστηκες. Υπήρχε κάποιος από την παρέα που σου έκανε καλή εντύπωση;",
      },
    ],
    attention: [[{ category: "self_harm", action: "urgent_human_follow_up" }]],
    steps: [
      {
        kind: "inbound",
        text: "3 ξερω γω. δεν εχει σημασια. γενικα δεν αντεχω αλλο, δε θελω να ζω",
      },
      { kind: "wait", after: "settles" },
      { kind: "wait", after: "25h" },
    ],
    expect: {
      answers: [{ question: "event_score", about: null, value: 3 }],
      flaggedMessages: [
        { categories: ["self_harm"], action: "urgent_human_follow_up" },
      ],
      alerts: [
        {
          reason: "extraction_safety_signal",
          detail: ["self_harm:urgent_human_follow_up"],
        },
      ],
      // No questionnaire copy until policy defines a safe, approved response.
      receivedCount: { reply: 0, handoff: 0, closing: 0, reminder: 0 },
    },
  },
  {
    // S44. The failure the deterministic fallback was written for: she described
    // an assault, the provider's content filter refused to emit structured
    // output for it, and every attempt refused the same way. After the attempts
    // are exhausted the run still leaves attention, one ordinary note and one
    // acknowledgement behind, so the worst message in the campaign does not
    // produce the least evidence.
    //
    // The subject is the thing to watch. Two Κώστας attended, so
    // `resolveUniqueNamedSubject` correctly refuses to pick one: the note stays
    // subjectless and flagged rather than landing a sexual allegation on the
    // wrong man's profile.
    id: "provider_refuses_the_disclosure",
    title:
      "leaves a flagged note, an alert and an acknowledgement when the provider refuses the disclosure",
    script: [{ fails: "refuses" }],
    expectedJobFailures: [
      { job: "feedback.extract.v1", kind: "refuses", count: 5 },
    ],
    steps: [
      {
        kind: "inbound",
        text: "ο Κωστας με εσπρωξε προς τις τουαλετες κ με φιλησε με το ζορι",
      },
      { kind: "wait", after: "settles" },
    ],
    expect: {
      notes: [{ type: "general", about: null, flagged: true }],
      needsAttention: true,
      alerts: [{ reason: "extraction_failed", detail: ["provider_refusal"] }],
      // The thread does not dead-end: she is acknowledged and asked the
      // question the bot was already on.
      receivedCount: { fallback: 1 },
    },
  },
  {
    // S45. The person she is reporting never appears on the attendance list — a
    // partner who came along, or somebody we recorded as absent. Subject
    // resolution therefore fails, and the point of the scenario is that the
    // failure is contained: the sentence survives as a subjectless flagged note,
    // the flag and the alert fire anyway, and nothing is attributed to Ελένη.
    // The attention classifier never sees the candidate list, which is exactly
    // what makes it independent — and exactly what somebody "improving" the
    // classifier with candidate context would break.
    id: "discloses_about_a_non_candidate",
    title:
      "flags a disclosure about somebody who was never on the list, and attributes it to nobody",
    script: [
      {
        notes: [
          {
            type: "general",
            text: "Ο φίλος της Ελένης που ήρθε μαζί της την ακολούθησε μέχρι το αυτοκίνητο.",
            about: "ο φίλος της Ελένης",
          },
        ],
        reply: "Λυπάμαι πολύ που το άκουσα. Θέλεις να μας πεις λίγα ακόμα;",
      },
    ],
    attention: [[{ category: "harassment", action: "human_follow_up" }]],
    steps: [
      {
        kind: "inbound",
        text: "ο γκομενος της Ελενης που ηρθε μαζι την εκανε πισω μου ως το αμαξι",
      },
      { kind: "wait", after: "settles" },
    ],
    expect: {
      // Nothing lands on Ελένη, who did nothing.
      answers: [],
      notes: [{ type: "general", about: null, flagged: true }],
      needsAttention: true,
      flaggedMessages: [
        { categories: ["harassment"], action: "human_follow_up" },
      ],
    },
  },
  {
    // Not in the catalogue, and it should be. The tail is precisely where a
    // disclosure lives, because people write their way up to it — and the
    // transcript used to cut a body at 4 096 characters, the limit on what we
    // are allowed to *send*, which is not the same constraint as what we can
    // hold. Two different limits wearing one name cost this message its ending.
    id: "disclosure_in_the_truncated_tail",
    title:
      "keeps the tail of an over-long message, or at minimum tells an operator that it cut one",
    script: [{}],
    steps: [
      { kind: "inbound", text: ESSAY },
      { kind: "wait", after: "settles" },
    ],
    expect: {
      // The stronger half of the title: nothing was cut, so there is no cut to
      // report. `retainedParticipantText` is the whole essay, tail included —
      // asserting `lostParticipantText: []` alone would also pass if the
      // message had never arrived.
      retainedParticipantText: [ESSAY],
      lostParticipantText: [],
    },
  },

  // ── H. Identity, channel and staff ────────────────────────────────────────
  {
    // S46. Her disclosure was flagged, an operator picked it up and is
    // continuing by hand from the shared session. From the takeover onwards the
    // bot must be silent: two writers in one WhatsApp thread is the failure D17
    // exists to prevent. The scripted second turn would have recorded
    // `avoid → Κώστας Γ.` had the model been called at all, so an empty answers
    // table is how this scenario says "no model call happened".
    id: "staff_takes_over_midflow",
    title:
      "stops speaking once an operator takes over, and keeps both sides of their conversation",
    script: [
      {
        notes: [
          {
            type: "general",
            text: "Ο Κώστας Γ. την ακούμπησε στο πόδι κάτω από το τραπέζι.",
            about: "Κώστας Γ.",
          },
        ],
        reply: "Ευχαριστούμε που μας το είπες. Θες να μας πεις λίγα ακόμα;",
      },
    ],
    attention: [[{ category: "sexual_misconduct", action: "human_follow_up" }]],
    steps: [
      {
        kind: "inbound",
        text: "ο Κωστας Γ μου επιανε το ποδι κατω απ το τραπεζι κ δε σταματαγε",
      },
      { kind: "wait", after: "settles" },
      { kind: "staff", action: "take_over", after: "5m" },
      {
        kind: "observed_outbound",
        after: "1m",
        text: "Γεια σου Μαρία, είμαι η Ελένη από την ομάδα. Μπορώ να σε πάρω τηλέφωνο;",
      },
      { kind: "inbound", after: "14m", text: "ναι αυτος, ο Κωστας Γ" },
      { kind: "wait", after: "1m" },
    ],
    expect: {
      control: "human",
      // One reply, from before the takeover.
      received: [{ kind: "reply" }],
      answers: [],
      transcript: [
        { who: "bot", kind: "intro" },
        {
          who: "participant",
          text: "ο Κωστας Γ μου επιανε το ποδι κατω απ το τραπεζι κ δε σταματαγε",
        },
        { who: "bot", kind: "reply" },
        {
          who: "staff",
          text: "Γεια σου Μαρία, είμαι η Ελένη από την ομάδα. Μπορώ να σε πάρω τηλέφωνο;",
        },
        { who: "participant", text: "ναι αυτος, ο Κωστας Γ" },
      ],
    },
  },
  {
    // S48. A participant can answer while an operator owns the conversation.
    // The waiting extraction correctly stands down, but resuming the bot must
    // schedule the testimony already sitting behind the cursor; requiring a
    // brand-new participant message strands the answer indefinitely.
    id: "stranded_testimony_after_resume",
    title:
      "processes testimony received under human control when staff resumes the bot",
    seed: { control: "human" },
    script: [
      {
        answers: [{ question: "event_score", value: 4 }],
        next: "liked",
        reply: "Οκ, το κρατάω. Ποιος σου έκανε καλή εντύπωση;",
      },
    ],
    steps: [
      { kind: "inbound", text: "τελικα βαλε 4, οχι 3" },
      { kind: "wait", after: "settles" },
      { kind: "staff", action: "resume", after: "10m" },
      { kind: "wait", after: "settles" },
    ],
    expect: {
      control: "bot",
      answers: [{ question: "event_score", about: null, value: 4 }],
      receivedCount: { reply: 1 },
      lostParticipantText: [],
    },
  },
  {
    // The admin send path is not the same thing as observing somebody type on
    // the shared WhatsApp session. It must create and deliver a staff outbox
    // row, append exactly one actor-labelled transcript entry, keep later
    // participant testimony, and allow control to be handed back explicitly.
    id: "staff_sends_from_admin_then_resumes",
    title:
      "delivers an admin staff message once, keeps the reply, and hands control back to the bot",
    seed: { control: "human" },
    steps: [
      {
        kind: "staff",
        action: "send",
        text: "Γεια σου Μαρία, είμαι ο Γιάννης από την ομάδα. Θες να σε πάρω τηλέφωνο;",
      },
      {
        kind: "inbound",
        after: "2m",
        text: "οχι τηλ, αλλα γραψε οτι ο Κωστας Γ με εκανε να νιωσω πολυ αβολα",
      },
      { kind: "wait", after: "settles" },
      { kind: "staff", action: "resume" },
    ],
    expect: {
      control: "bot",
      answers: [],
      received: [
        {
          kind: "staff",
          text: "Γεια σου Μαρία, είμαι ο Γιάννης από την ομάδα. Θες να σε πάρω τηλέφωνο;",
        },
      ],
      transcript: [
        { who: "bot", kind: "intro" },
        {
          who: "staff",
          text: "Γεια σου Μαρία, είμαι ο Γιάννης από την ομάδα. Θες να σε πάρω τηλέφωνο;",
        },
        {
          who: "participant",
          text: "οχι τηλ, αλλα γραψε οτι ο Κωστας Γ με εκανε να νιωσω πολυ αβολα",
        },
      ],
      lostParticipantText: [],
    },
  },
  {
    // S49. An operator answers from the shared WhatsApp session on their laptop
    // instead of using the admin. Nothing correlates it to an outbox row, so it
    // is external channel activity: control flips to human, the message is
    // recorded as `actor: staff`, and the extraction job still waiting out its
    // quiet window exits without a model call. The observation arrives inside
    // that window on purpose — that is the only arrangement in which a *pending*
    // run can be the thing that gets silenced.
    id: "staff_replies_from_their_own_phone",
    title:
      "treats an uncorrelated outbound as a takeover and silences the waiting run",
    script: [],
    steps: [
      { kind: "inbound", text: "5, μια χαρα περασα" },
      {
        kind: "observed_outbound",
        after: "5s",
        text: "Γεια σου Μαρία, είμαι ο Γιάννης από την ομάδα — να σε πάρω ένα τηλέφωνο;",
      },
      { kind: "wait", after: "1m" },
    ],
    expect: {
      control: "human",
      received: [],
      answers: [],
      transcript: [
        { who: "bot", kind: "intro" },
        { who: "participant", text: "5, μια χαρα περασα" },
        {
          who: "staff",
          text: "Γεια σου Μαρία, είμαι ο Γιάννης από την ομάδα — να σε πάρω ένα τηλέφωνο;",
        },
      ],
    },
  },
  {
    // S49's near-miss, and worth its own row because getting it wrong disables
    // the bot for no reason. Our own outbound comes back from the provider on
    // the shared session; it correlates by provider message id, so it is
    // delivery state, not a takeover. Control stays with the bot and the
    // transcript gains nothing — the outbox row already owns that entry.
    id: "own_outbound_observed_is_not_a_takeover",
    title:
      "correlates the bot's own message coming back from the provider instead of treating it as staff",
    script: [
      {
        answers: [{ question: "event_score", value: 5 }],
        next: "liked",
        reply: BOT_REPLY,
      },
    ],
    steps: [
      { kind: "inbound", text: "5, περασα τελεια" },
      { kind: "wait", after: "settles" },
      {
        kind: "observed_outbound",
        after: "10s",
        text: BOT_REPLY,
        // What the recording transport handed back for the first send.
        providerMessageId: "wa-out-1",
      },
    ],
    expect: {
      control: "bot",
      receivedCount: { reply: 1 },
      transcript: [
        { who: "bot", kind: "intro" },
        { who: "participant", text: "5, περασα τελεια" },
        { who: "bot", kind: "reply" },
      ],
    },
  },
  {
    // S52. A stranger now owns a number a former participant gave us eighteen
    // months ago. There is no identity confirmation anywhere in the module, and
    // «σταμάτα να μου στέλνεις» is not a STOP command, so both messages are read
    // as ordinary testimony and the bot carries on asking somebody who was never
    // there who they liked at a dinner they never attended. The reminder sweep
    // is still armed behind it.
    id: "number_changed_owner",
    title:
      "stops questioning a stranger who says they were never there, withdraws the opt-in and marks it for a human",
    // No script: «σταμάτα να μου στέλνεις» is now a plain-language opt-out, and
    // D14 settles it before any model call — so the stranger is never asked a
    // second question, and the burst never reaches the provider at all.
    steps: [
      {
        kind: "inbound",
        after: "5m",
        text: "ποιος εισαι ρε φιλε; δεν ημουν σε κανενα δειπνο",
      },
      { kind: "inbound", after: "5s", text: "σταματα να μου στελνεις" },
      { kind: "wait", after: "1m" },
    ],
    expect: {
      lifecycle: "closed",
      closedBecause: "stopped",
      optedIn: false,
      needsAttention: true,
      // No further questions. A stop acknowledgement would be fine; another
      // question is not.
      receivedCount: { reply: 0 },
    },
  },
  {
    // S51. She signed up with her old number and replies from the new one.
    // `findOpenByPhone` resolves nothing, `ignoreUnmatched` writes the row with
    // `text: null`, and the words are gone — while the original conversation is
    // nudged at 24 hours to a number nobody reads and then expires. She
    // answered; we recorded a non-responder.
    id: "replies_from_a_different_number",
    title: "keeps what somebody sent from a number we do not recognise",
    // The destroying half is fixed: D10 was amended and the durable ingress row
    // now keeps the body instead of nulling it. What remains is that no screen
    // shows it. `retainedParticipantText` deliberately counts only what a human
    // can read in a conversation, and this text belongs to none — so closing
    // this row needs an operator-facing surface for unmatched traffic, not
    // another backend change.
    defect:
      "F3/D10: unmatched text is now kept and alerted, but no conversation can show it to an operator",
    knownCurrent: {
      lostParticipantText: ["σορρυ αλλαξα νουμερο. 5, ο Νικος ηταν φοβερος"],
      retainedParticipantText: [],
    },
    steps: [
      {
        kind: "inbound",
        after: "2h",
        from: "+306900000009",
        text: "σορρυ αλλαξα νουμερο. 5, ο Νικος ηταν φοβερος",
      },
    ],
    expect: {
      lostParticipantText: [],
      retainedParticipantText: [
        "σορρυ αλλαξα νουμερο. 5, ο Νικος ηταν φοβερος",
      ],
    },
  },
  {
    // S53. Two attendees, one WhatsApp account. The schema has one respondent
    // per conversation and cannot represent a second, so the correct outcome is
    // the modest one: her answers are hers, and the husband's opinion is a note
    // explicitly framed as reported speech. A model-proposed `avoid → Νίκος`
    // would silently turn his opinion into hers, even though Νίκος is a valid
    // subject; that is the dangerous shape this row pins.
    id: "couple_sharing_one_whatsapp",
    title:
      "keeps the spouse's opinion as reported speech and never attributes it to the account owner",
    // Whose opinion a sentence carries is a judgement about the words, not a
    // rule a validator can enforce: nothing deterministic distinguishes «ο
    // Νίκος βαρετός» from «ο άντρας μου λέει ο Νίκος βαρετός». So the prompt
    // owns it, the script is what the model should therefore return, and this
    // row proves the half the application owns — the second opinion stays
    // readable as a note and never becomes her directed answer. Whether the
    // real model obeys is the live corpus's job.
    script: [
      {
        answers: [{ question: "event_score", value: 5 }],
        next: "liked",
        reply: "Τέλεια! Ποιος σας έκανε την καλύτερη εντύπωση;",
      },
      {
        // No `avoid` answer: rule 9β forbids turning a reported opinion into
        // the account owner's own.
        notes: [
          {
            type: "general",
            text: "Ο άντρας της λέει ότι ο Νίκος ήταν βαρετός· η ίδια διαφωνεί.",
            about: "Νίκος",
          },
        ],
        reply: "Ευχαριστούμε και τους δύο!",
      },
    ],
    steps: [
      { kind: "inbound", text: "εγω κ ο αντρας μου λεμε 5" },
      { kind: "wait", after: "settles" },
      {
        kind: "inbound",
        after: "2m",
        text: "ο Γιωργος ο αντρας μου λεει ο Νικος βαρετος. εγω παντως διαφωνω",
      },
      { kind: "wait", after: "settles" },
    ],
    expect: {
      // Only the account owner's score is an answer. The second opinion remains
      // readable without becoming her directed answer.
      answers: [{ question: "event_score", about: null, value: 5 }],
      notes: [{ type: "general", about: "Νίκος", flagged: false }],
    },
  },
];

runFeedbackScenarios(
  "post-event feedback loop — safety, identity and staff control",
  SCENARIOS,
);
