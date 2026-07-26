import {
  runFeedbackScenarios,
  type FeedbackScenario,
} from "./post-event-feedback-loop.harness.js";

/**
 * Focused fake-backed race narratives. The model barrier opens only after the
 * extractor has snapshotted conversation, campaign and consent state. The
 * action then travels through the same public service/store boundary it uses in
 * production before the provider call is released.
 *
 * These are behavioural tests, not E2E tests. Real MongoDB, PostgreSQL, Redis
 * and WhatsApp are intentionally absent.
 */
const MODEL_CALL_RACES: readonly FeedbackScenario[] = [
  {
    id: "takeover_during_the_model_call",
    title: "does not send the model reply after staff takes control",
    defect:
      "S47: control is snapshotted before the provider call and is not reloaded before the outbox insert",
    script: [
      {
        answers: [{ question: "event_score", value: 5 }],
        next: "liked",
        reply: "Χαίρομαι! Ποιος σου έκανε την καλύτερη εντύπωση;",
      },
    ],
    steps: [
      { kind: "inbound", text: "5, πέρασα πολύ ωραία" },
      {
        kind: "during_model",
        after: "settles",
        action: { kind: "staff", action: "take_over" },
      },
    ],
    knownCurrent: {
      control: "human",
      receivedCount: { reply: 1 },
    },
    expect: {
      control: "human",
      receivedCount: { reply: 0 },
    },
  },
  {
    id: "stop_during_the_model_call",
    title: "lets STOP cancel an in-flight reply before it reaches the phone",
    script: [
      {
        answers: [{ question: "event_score", value: 5 }],
        next: "liked",
        reply: "Χαίρομαι! Ποιος σου έκανε την καλύτερη εντύπωση;",
      },
    ],
    steps: [
      { kind: "inbound", text: "5, πέρασα πολύ ωραία" },
      {
        kind: "during_model",
        after: "settles",
        action: { kind: "inbound", text: "STOP" },
      },
    ],
    expect: {
      lifecycle: "closed",
      closedBecause: "stopped",
      optedIn: false,
      receivedCount: { reply: 0, stop_ack: 1 },
    },
  },
  {
    id: "staff_close_during_the_model_call",
    title: "does not send the model reply after staff closes the conversation",
    defect:
      "LIFECYCLE-RACE: a reply can be inserted after staff close already cancelled the queued outbox",
    script: [
      {
        answers: [{ question: "event_score", value: 4 }],
        next: "liked",
        reply: "Ευχαριστούμε. Ποιος σου έκανε καλή εντύπωση;",
      },
    ],
    steps: [
      { kind: "inbound", text: "4" },
      {
        kind: "during_model",
        after: "settles",
        action: { kind: "staff", action: "close" },
      },
    ],
    knownCurrent: {
      lifecycle: "closed",
      closedBecause: "cancelled",
      receivedCount: { reply: 1 },
    },
    expect: {
      lifecycle: "closed",
      closedBecause: "cancelled",
      receivedCount: { reply: 0 },
    },
  },
  {
    id: "campaign_pause_during_the_model_call",
    title:
      "keeps an in-flight reply off the phone after the campaign is paused",
    script: [
      {
        answers: [{ question: "event_score", value: 4 }],
        next: "liked",
        reply: "Ευχαριστούμε. Ποιος σου έκανε καλή εντύπωση;",
      },
    ],
    steps: [
      { kind: "inbound", text: "4" },
      {
        kind: "during_model",
        after: "settles",
        action: { kind: "campaign", status: "paused" },
      },
    ],
    expect: {
      answers: [{ question: "event_score", about: null, value: 4 }],
      receivedCount: { reply: 0 },
    },
  },
  {
    id: "consent_withdrawn_during_the_model_call",
    title: "does not send the model reply after consent is withdrawn",
    defect:
      "CONSENT-RACE: opt-in is snapshotted before the provider call and delivery does not re-check it",
    script: [
      {
        answers: [{ question: "event_score", value: 3 }],
        next: "liked",
        reply: "Ευχαριστούμε. Ποιος σου έκανε καλή εντύπωση;",
      },
    ],
    steps: [
      { kind: "inbound", text: "3" },
      {
        kind: "during_model",
        after: "settles",
        action: { kind: "consent", optedIn: false },
      },
    ],
    knownCurrent: {
      optedIn: false,
      receivedCount: { reply: 1 },
    },
    expect: {
      optedIn: false,
      receivedCount: { reply: 0 },
    },
  },
];

runFeedbackScenarios(
  "post-event feedback loop — state changes during a model call",
  MODEL_CALL_RACES,
);
