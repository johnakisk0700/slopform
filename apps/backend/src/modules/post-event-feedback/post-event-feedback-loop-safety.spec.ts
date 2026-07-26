import {
  runFeedbackScenarios,
  type FeedbackScenario,
} from "./post-event-feedback-loop.harness.js";

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
