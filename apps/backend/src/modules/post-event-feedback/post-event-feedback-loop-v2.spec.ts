import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createFeedbackLoopHarness,
  runFeedbackScenarios,
  type FeedbackScenario,
  type FeedbackScenarioVenue,
} from "./post-event-feedback-loop.harness.js";
import {
  POST_EVENT_FEEDBACK_FALLBACK_ACK,
  POST_EVENT_FEEDBACK_HANDOFF_REPLY,
} from "./extraction/extraction.schemas.js";
import { FeedbackExtractionGenerationError } from "./extraction/model.service.js";
import { POST_EVENT_FEEDBACK_QUESTION_SET_V2 } from "./question-set.js";

const V2_COPY = POST_EVENT_FEEDBACK_QUESTION_SET_V2.copy;
const NAKAMA_VENUE = {
  provider: "google",
  placeId: "ChIJ-google-place-id-never-reaches-the-model",
  label: "Nakama",
  type: "japanese restaurant",
  area: "Κέντρο Αθήνας",
  priceRange: {
    startMinor: 1_500,
    endMinor: 3_000,
    currencyCode: "EUR",
  },
  useInFeedback: true,
} as const satisfies FeedbackScenarioVenue;

const NEW_VENUE = {
  provider: "google",
  placeId: "ChIJ-second-google-place-id-also-stays-out",
  label: "Το Νέο Στέκι",
  type: "μεζεδοπωλείο",
  area: "Παγκράτι",
  priceLevel: "moderate",
  useInFeedback: true,
} as const satisfies FeedbackScenarioVenue;

const V2_SCENARIOS: readonly FeedbackScenario[] = [
  {
    id: "v2_table_fit",
    title: "records table fit and advances to participation ease",
    seed: {
      goals: { event_score: "skipped", table_fit: "asked" },
    },
    script: [
      {
        answers: [{ question: "table_fit", value: 4 }],
        next: "participation_ease",
        reply:
          "Ωραία. Πόσο εύκολο ήταν για σένα να μπεις και να συμμετέχεις στη συζήτηση, από το 1 ως το 5;",
      },
    ],
    steps: [
      { kind: "inbound", text: "Για το ταίριασμα της παρέας βάζω 4" },
      { kind: "wait", after: "settles" },
    ],
    expect: {
      answers: [{ question: "table_fit", about: null, value: 4 }],
      received: [{ kind: "reply" }],
      lifecycle: "open",
    },
  },
  {
    id: "v2_participation_ease",
    title: "records participation ease and advances to conversation balance",
    seed: {
      goals: {
        event_score: "skipped",
        table_fit: "skipped",
        participation_ease: "asked",
      },
    },
    script: [
      {
        answers: [{ question: "participation_ease", value: 3 }],
        next: "conversation_balance",
        reply: "Και πόσο ισορροπημένη ήταν η συζήτηση; Βάλε από 1 ως 5.",
      },
    ],
    steps: [
      { kind: "inbound", text: "Στη συμμετοχή 3, άργησα λίγο να μπω" },
      { kind: "wait", after: "settles" },
    ],
    expect: {
      answers: [{ question: "participation_ease", about: null, value: 3 }],
      received: [{ kind: "reply" }],
      lifecycle: "open",
    },
  },
  {
    id: "v2_conversation_balance",
    title: "records conversation balance and advances to meet again",
    seed: {
      goals: {
        event_score: "skipped",
        table_fit: "skipped",
        participation_ease: "skipped",
        conversation_balance: "asked",
      },
    },
    script: [
      {
        answers: [{ question: "conversation_balance", value: 2 }],
        next: "meet_again",
        reply:
          "Με ποιους από την παρέα θα χαιρόσουν να ξαναβρεθείς σε επόμενο τραπέζι;",
      },
    ],
    steps: [
      { kind: "inbound", text: "Ισορροπία 2, μιλούσαν κυρίως δύο άτομα" },
      { kind: "wait", after: "settles" },
    ],
    expect: {
      answers: [{ question: "conversation_balance", about: null, value: 2 }],
      received: [{ kind: "reply" }],
      lifecycle: "open",
    },
  },
  {
    id: "v2_slow_fragmented_scores",
    title: "reads one slowly typed V2 thought once without losing a dimension",
    script: [
      {
        answers: [
          { question: "event_score", value: 4 },
          { question: "table_fit", value: 2 },
          { question: "participation_ease", value: 4 },
          { question: "conversation_balance", value: 1 },
        ],
        next: "meet_again",
        reply: V2_COPY.meet_again,
      },
    ],
    steps: [
      { kind: "inbound", text: "genika 4, kala htan" },
      {
        kind: "inbound",
        text: "parea 2 omws, ligo akyro to setimo",
        after: "25s",
      },
      { kind: "inbound", text: "mpika eykola 4", after: "25s" },
      {
        kind: "inbound",
        text: "isorropia 1, dyo mas priksan t aftia",
        after: "25s",
      },
      { kind: "wait", after: "settles" },
    ],
    expect: {
      answers: [
        { question: "event_score", about: null, value: 4 },
        { question: "table_fit", about: null, value: 2 },
        { question: "participation_ease", about: null, value: 4 },
        { question: "conversation_balance", about: null, value: 1 },
      ],
      receivedCount: { reply: 1 },
    },
  },
  {
    id: "v2_table_fit_changes_during_model_call",
    title: "records the corrected V2 table-fit score from newer testimony",
    seed: {
      goals: { event_score: "skipped", table_fit: "asked" },
    },
    script: [
      {
        answers: [{ question: "table_fit", value: 2 }],
        next: "participation_ease",
        reply: V2_COPY.participation_ease,
      },
      {
        answers: [{ question: "table_fit", value: 4 }],
        next: "participation_ease",
        reply: V2_COPY.participation_ease,
      },
    ],
    steps: [
      { kind: "inbound", text: "parea 2, den ekatse katholou" },
      {
        kind: "during_model",
        after: "settles",
        action: {
          kind: "inbound",
          text: "akuro re 4, egw hmoun ptwma kai to adikhsa",
        },
      },
      { kind: "wait", after: "settles" },
    ],
    expect: {
      answers: [{ question: "table_fit", about: null, value: 4 }],
      receivedCount: { reply: 1 },
      lostParticipantText: [],
    },
  },
  {
    id: "v2_takeover_during_model_call",
    title: "does not let the V2 bot speak after staff takes control",
    seed: {
      goals: { event_score: "skipped", table_fit: "asked" },
    },
    script: [
      {
        answers: [{ question: "table_fit", value: 5 }],
        next: "participation_ease",
        reply: V2_COPY.participation_ease,
      },
    ],
    steps: [
      { kind: "inbound", text: "parea 5, mia xara kollisame" },
      {
        kind: "during_model",
        after: "settles",
        action: { kind: "staff", action: "take_over" },
      },
    ],
    expect: {
      control: "human",
      receivedCount: { reply: 0 },
    },
  },
  {
    id: "v2_close_during_model_call",
    title: "does not let the V2 bot speak after staff closes the conversation",
    seed: {
      goals: {
        event_score: "skipped",
        table_fit: "skipped",
        participation_ease: "asked",
      },
    },
    script: [
      {
        answers: [{ question: "participation_ease", value: 1 }],
        next: "conversation_balance",
        reply: V2_COPY.conversation_balance,
      },
    ],
    steps: [
      { kind: "inbound", text: "1. de me afhse kaneis na staurwsw leksh" },
      {
        kind: "during_model",
        after: "settles",
        action: { kind: "staff", action: "close" },
      },
    ],
    expect: {
      lifecycle: "closed",
      closedBecause: "cancelled",
      receivedCount: { reply: 0 },
    },
  },
  {
    id: "v2_admin_send_then_resume",
    title:
      "delivers the admin message and processes the V2 answer waiting on resume",
    seed: {
      control: "human",
      goals: { event_score: "skipped", table_fit: "asked" },
    },
    script: [
      {
        answers: [{ question: "table_fit", value: 3 }],
        next: "participation_ease",
        reply: V2_COPY.participation_ease,
      },
    ],
    steps: [
      {
        kind: "staff",
        action: "send",
        text: "Γεια σου Μαρία, είμαι η Έλενα από την ομάδα. Γράψε μου εδώ, χωρίς τηλέφωνο.",
      },
      {
        kind: "inbound",
        text: "ok. parees 3, sthn arxh hmoun ligo koumpwmenos",
        after: "2m",
      },
      { kind: "wait", after: "settles" },
      { kind: "staff", action: "resume", after: "5m" },
      { kind: "wait", after: "settles" },
    ],
    expect: {
      control: "bot",
      answers: [{ question: "table_fit", about: null, value: 3 }],
      received: [{ kind: "staff" }, { kind: "reply" }],
      transcript: [
        { who: "bot", kind: "intro" },
        { who: "staff" },
        {
          who: "participant",
          text: "ok. parees 3, sthn arxh hmoun ligo koumpwmenos",
        },
        { who: "bot", kind: "reply" },
      ],
    },
  },
  {
    id: "v2_answers_everything_at_once",
    title: "records all six V2 goals and closes after one compact answer",
    script: [
      {
        answers: [
          { question: "event_score", value: 4 },
          { question: "table_fit", value: 5 },
          { question: "participation_ease", value: 4 },
          { question: "conversation_balance", value: 3 },
          { question: "meet_again", about: "Νίκος" },
        ],
        skip: ["avoid"],
      },
    ],
    steps: [
      {
        kind: "inbound",
        text: "Συνολικά 4, ταίριασμα 5, συμμετοχή 4 και ισορροπία 3. Με τον Νίκο θα ξανακαθόμουν· να αποφύγω κανέναν.",
      },
      { kind: "wait", after: "settles" },
    ],
    expect: {
      answers: [
        { question: "event_score", about: null, value: 4 },
        { question: "table_fit", about: null, value: 5 },
        { question: "participation_ease", about: null, value: 4 },
        { question: "conversation_balance", about: null, value: 3 },
        { question: "meet_again", about: "Νίκος", value: null },
      ],
      received: [{ kind: "closing" }],
      lifecycle: "closed",
      closedBecause: "completed",
    },
  },
  {
    id: "v2_declines_whole_questionnaire",
    title: "declines all six optional questions and closes without a reminder",
    script: [
      {
        skip: [
          "event_score",
          "table_fit",
          "participation_ease",
          "conversation_balance",
          "meet_again",
          "avoid",
        ],
      },
    ],
    attention: [{ hostileToUs: false }],
    steps: [
      {
        kind: "inbound",
        text: "Δεν θέλω να απαντήσω σε καμία από τις έξι ερωτήσεις.",
      },
      { kind: "inbound", text: "Σε καμία, είπα.", after: "8s" },
      { kind: "wait", after: "settles" },
      { kind: "wait", after: "25h" },
    ],
    expect: {
      answers: [],
      lifecycle: "closed",
      closedBecause: "declined",
      optedIn: true,
      needsAttention: false,
      received: [{ kind: "declined", text: V2_COPY.declined }],
      receivedCount: { closing: 0, reminder: 0 },
    },
  },
  {
    id: "v2_stop_during_model_call",
    title: "uses the V2 STOP acknowledgement and cancels an in-flight reply",
    script: [
      {
        answers: [{ question: "event_score", value: 5 }],
        next: "table_fit",
        reply: V2_COPY.table_fit,
      },
    ],
    steps: [
      { kind: "inbound", text: "5, πέρασα πολύ ωραία" },
      {
        kind: "during_model",
        after: "settles",
        action: { kind: "inbound", text: "ΣΤΟΠ" },
      },
    ],
    expect: {
      lifecycle: "closed",
      closedBecause: "stopped",
      optedIn: false,
      received: [{ kind: "stop_ack", text: V2_COPY.stop_ack }],
      receivedCount: { reply: 0, stop_ack: 1 },
    },
  },
  {
    id: "v2_safety_handoff_preserves_questionnaire",
    title:
      "keeps the V2 goal ladder intact through a safety handoff and staff resume",
    script: [
      {
        answers: [{ question: "event_score", value: 2 }],
        notes: [
          {
            type: "general",
            text: "Ο Κώστας Γ. την έκανε να νιώσει ανασφάλεια και ζήτησε να μιλήσει με άνθρωπο.",
            about: "Κώστας Γ.",
          },
        ],
        handoff: true,
      },
      {
        answers: [{ question: "table_fit", value: 4 }],
        next: "participation_ease",
        reply: V2_COPY.participation_ease,
      },
    ],
    attention: [[{ category: "harassment", action: "human_follow_up" }], []],
    steps: [
      {
        kind: "inbound",
        text: "2. Ο Κώστας Γ. με έκανε να νιώσω ανασφάλεια και θέλω να μιλήσω με άνθρωπο.",
      },
      { kind: "wait", after: "settles" },
      { kind: "staff", action: "take_over", after: "5m" },
      { kind: "staff", action: "resume", after: "5m" },
      {
        kind: "inbound",
        text: "Για το ταίριασμα της παρέας βάζω 4.",
        after: "1m",
      },
      { kind: "wait", after: "settles" },
    ],
    expect: {
      answers: [
        { question: "event_score", about: null, value: 2 },
        { question: "table_fit", about: null, value: 4 },
      ],
      received: [
        { kind: "handoff", text: POST_EVENT_FEEDBACK_HANDOFF_REPLY },
        { kind: "reply" },
      ],
      flaggedMessages: [
        { categories: ["harassment"], action: "human_follow_up" },
      ],
      needsAttention: true,
      control: "bot",
      lifecycle: "open",
    },
  },
  {
    id: "v2_fallback_resumes_current_goal",
    title: "appends the actual V2 participation prompt after a dead extraction",
    seed: {
      goals: {
        event_score: "skipped",
        table_fit: "skipped",
        participation_ease: "asked",
      },
    },
    script: [{ fails: "refuses" }],
    expectedJobFailures: [
      { job: "feedback.extract.v1", kind: "refuses", count: 5 },
    ],
    steps: [
      {
        kind: "inbound",
        text: "Δεν ξέρω πώς να το εξηγήσω, αλλά δυσκολεύτηκα να μπω στη συζήτηση.",
      },
      { kind: "wait", after: "settles" },
    ],
    expect: {
      notes: [{ type: "general", about: null, flagged: true }],
      needsAttention: true,
      received: [
        {
          kind: "fallback",
          text: `${POST_EVENT_FEEDBACK_FALLBACK_ACK} ${V2_COPY.participation_ease}`,
        },
      ],
      lifecycle: "open",
    },
  },
  {
    id: "v2_reminder_restates_table_fit",
    title: "reminds with table fit after the overall score was recorded",
    script: [
      {
        answers: [{ question: "event_score", value: 5 }],
        next: "table_fit",
        reply: V2_COPY.table_fit,
      },
    ],
    steps: [
      { kind: "inbound", text: "Συνολικά βάζω 5." },
      { kind: "wait", after: "settles" },
      { kind: "wait", after: "25h" },
    ],
    expect: {
      answers: [{ question: "event_score", about: null, value: 5 }],
      received: [
        { kind: "reply" },
        {
          kind: "reminder",
          text: expect.stringContaining(V2_COPY.table_fit),
        },
      ],
      receivedCount: { reminder: 1 },
      lifecycle: "open",
    },
  },
  {
    id: "v2_reply_at_hour_71",
    title: "keeps a late V2 response open and advances to table fit",
    script: [
      {
        answers: [{ question: "event_score", value: 4 }],
        next: "table_fit",
        reply: V2_COPY.table_fit,
      },
    ],
    steps: [
      {
        kind: "inbound",
        text: "Συγγνώμη, τώρα το είδα. Συνολικά 4.",
        after: "71h",
      },
      { kind: "wait", after: "70m" },
    ],
    expect: {
      answers: [{ question: "event_score", about: null, value: 4 }],
      receivedCount: { reminder: 2, reply: 1 },
      lifecycle: "open",
      closedBecause: null,
    },
  },
];

runFeedbackScenarios(
  "post-event feedback loop — questionnaire V2",
  V2_SCENARIOS,
);

describe("post-event feedback loop harness V2 default", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("seeds a V2 campaign snapshot and exactly the six V2 goals", async () => {
    const harness = await createFeedbackLoopHarness();
    const campaign = [...harness.repository.campaigns.values()][0];
    const conversation = harness.conversations.get(harness.conversationId);

    expect(campaign?.questionSetVersion).toBe(2);
    expect(campaign?.questions).toMatchObject({ questionSetVersion: 2 });
    expect(conversation.goals.map((goal) => goal.key)).toEqual([
      "event_score",
      "table_fit",
      "participation_ease",
      "conversation_balance",
      "meet_again",
      "avoid",
    ]);
  });
});

describe("post-event feedback loop — V2 venue context", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("passes the enabled venue's safe fields to the model without its Google placeId", async () => {
    const harness = await createFeedbackLoopHarness({
      venue: NAKAMA_VENUE,
      venueContextRevision: 7,
    });
    harness.model.script([
      {
        answers: [{ question: "event_score", value: 4 }],
        next: "table_fit",
        reply: V2_COPY.table_fit,
      },
    ]);
    harness.model.scriptAttention([[]]);

    await harness.run([
      { kind: "inbound", text: "4 βαζω, μια χαρα ηταν" },
      { kind: "wait", after: "settles" },
    ]);

    expect(harness.model.extractionPrompts).toHaveLength(1);
    const prompt = harness.model.extractionPrompts[0];
    expect(prompt?.user).toContain('- όνομα: "Nakama"');
    expect(prompt?.user).toContain('- τύπος: "japanese restaurant"');
    expect(prompt?.user).toContain('- περιοχή: "Κέντρο Αθήνας"');
    expect(prompt?.user).toContain("- κόστος ανά άτομο: 15–30 EUR");
    expect(`${prompt?.system}\n${prompt?.user}`).not.toContain(
      NAKAMA_VENUE.placeId,
    );
    expect(harness.events.venueRevisionChecks).toEqual([7]);
    expect(harness.outcome()).toMatchObject({
      answers: [{ question: "event_score", about: null, value: 4 }],
    });
  });

  it("keeps a complaint about the venue as a subjectless general note", async () => {
    const harness = await createFeedbackLoopHarness({
      venue: NAKAMA_VENUE,
      venueContextRevision: 4,
    });
    harness.model.script([
      {
        answers: [{ question: "event_score", value: 1 }],
        notes: [
          {
            type: "general",
            text: "Το τραπέζι ήταν δίπλα στις τουαλέτες και το φαγητό ήρθε κρύο.",
          },
        ],
        next: "table_fit",
        reply: V2_COPY.table_fit,
      },
    ]);
    harness.model.scriptAttention([[]]);

    await harness.run([
      {
        kind: "inbound",
        text: "ρε παιδια το μαγαζι χαλια, μας ειχαν διπλα στις τουαλετες κ το φαι ηρθε παγωμενο. 1 βαζω",
      },
      { kind: "wait", after: "settles" },
    ]);

    expect(harness.outcome()).toMatchObject({
      answers: [{ question: "event_score", about: null, value: 1 }],
      notes: [
        {
          type: "general",
          about: null,
          flagged: false,
        },
      ],
    });
  });

  it("discards an in-flight reply after venue replacement and retries with the replacement", async () => {
    const harness = await createFeedbackLoopHarness({
      venue: NAKAMA_VENUE,
      venueContextRevision: 9,
    });
    harness.model.script([
      {
        answers: [{ question: "event_score", value: 1 }],
        next: "table_fit",
        reply: "Για το παλιό μαγαζί το σημείωσα. Πόσο σου ταίριαξε η παρέα;",
      },
      {
        answers: [{ question: "event_score", value: 4 }],
        next: "table_fit",
        reply: "Οκ, για το νέο μέρος. Πόσο σου ταίριαξε η παρέα;",
      },
    ]);
    harness.model.scriptAttention([[], []]);

    await harness.apply({ kind: "inbound", text: "τελικα 4 βαζω" });
    await harness.apply({
      kind: "during_model",
      after: "settles",
      action: { kind: "venue", action: "replace", venue: NEW_VENUE },
    });

    expect(harness.model.extractionPrompts).toHaveLength(2);
    expect(harness.model.extractionPrompts[0]?.user).toContain(
      '- όνομα: "Nakama"',
    );
    expect(harness.model.extractionPrompts[1]?.user).toContain(
      '- όνομα: "Το Νέο Στέκι"',
    );
    expect(harness.model.extractionPrompts[1]?.user).not.toContain(
      NAKAMA_VENUE.label,
    );
    expect(harness.events.venueRevisionChecks).toEqual([9, 10]);
    expect(harness.failures).toHaveLength(1);
    expect(harness.failures[0]?.error).toBeInstanceOf(
      FeedbackExtractionGenerationError,
    );
    expect(harness.failures[0]?.error).toMatchObject({
      retryable: true,
      failureCause: "validation_failed",
    });
    expect(harness.outcome()).toMatchObject({
      answers: [{ question: "event_score", about: null, value: 4 }],
      receivedCount: { reply: 1 },
    });
    expect(harness.repository.outboxLogs).toHaveLength(1);
    expect(harness.repository.outboxLogs[0]?.decision).toMatchObject({
      origin: "extraction_reply",
      venueContextRevision: 10,
    });
    expect(harness.transport.sent.map((message) => message.text)).not.toContain(
      "Για το παλιό μαγαζί το σημείωσα. Πόσο σου ταίριαξε η παρέα;",
    );
  });

  it("retries venue-blind when staff disable the venue during the model call", async () => {
    const harness = await createFeedbackLoopHarness({
      venue: NAKAMA_VENUE,
      venueContextRevision: 12,
    });
    harness.model.script([
      {
        answers: [{ question: "event_score", value: 2 }],
        next: "table_fit",
        reply:
          "Το παλιό venue reply δεν πρέπει να σταλεί. Πόσο ταίριαξε η παρέα;",
      },
      {
        answers: [{ question: "event_score", value: 5 }],
        next: "table_fit",
        reply: V2_COPY.table_fit,
      },
    ]);
    harness.model.scriptAttention([[], []]);

    await harness.apply({ kind: "inbound", text: "5 τελικα" });
    await harness.apply({
      kind: "during_model",
      after: "settles",
      action: { kind: "venue", action: "disable" },
    });

    expect(harness.model.extractionPrompts).toHaveLength(2);
    expect(harness.model.extractionPrompts[0]?.user).toContain("ΠΛΑΙΣΙΟ ΧΩΡΟΥ");
    expect(harness.model.extractionPrompts[1]?.user).not.toContain(
      "ΠΛΑΙΣΙΟ ΧΩΡΟΥ",
    );
    // The retry did not see a venue, so it deliberately has no revision fence.
    expect(harness.events.venueRevisionChecks).toEqual([12]);
    expect(harness.failures).toHaveLength(1);
    expect(harness.outcome()).toMatchObject({
      answers: [{ question: "event_score", about: null, value: 5 }],
      receivedCount: { reply: 1 },
    });
    expect(harness.repository.outboxLogs).toHaveLength(1);
    expect(harness.repository.outboxLogs[0]?.decision).toMatchObject({
      origin: "extraction_reply",
      venueContextRevision: null,
    });
  });
});
