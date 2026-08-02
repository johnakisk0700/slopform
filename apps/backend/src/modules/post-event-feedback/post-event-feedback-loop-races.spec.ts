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
 * Every row here asks one question: the run decided to speak using state read
 * seconds ago — is it still allowed to? The guards at the top of a run were
 * correct and simply too early, so three of these were ledger entries until the
 * decision to send was re-taken against reloaded state immediately before the
 * outbox insert.
 *
 * These are behavioural tests, not E2E tests. Real MongoDB, PostgreSQL, Redis
 * and WhatsApp are intentionally absent.
 */
const MODEL_CALL_RACES: readonly FeedbackScenario[] = [
  {
    id: "takeover_during_the_model_call",
    title: "does not send the model reply after staff takes control",
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
    expect: {
      optedIn: false,
      receivedCount: { reply: 0 },
    },
  },
];

runFeedbackScenarios(
  "post-event feedback loop — state changes during a model call",
  MODEL_CALL_RACES,
  { questionSetVersion: 1 },
);
