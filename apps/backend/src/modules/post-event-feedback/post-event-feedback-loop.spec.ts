import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createFeedbackLoopHarness,
  DEFAULT_RESPONDENT,
  runFeedbackScenarios,
  type FeedbackScenario,
} from "./post-event-feedback-loop.harness.js";
import { SCRIPT_MODEL } from "./post-event-feedback-loop-model.harness.js";
import {
  POST_EVENT_FEEDBACK_QUESTION_SET_V1,
  renderPostEventFeedbackCopy,
} from "./question-set.js";

const REMINDER_COPY = renderPostEventFeedbackCopy(
  POST_EVENT_FEEDBACK_QUESTION_SET_V1.copy.reminder,
  DEFAULT_RESPONDENT,
);

/**
 * The three proving scenarios for the post-event feedback loop harness.
 *
 * They exist to fix the *shape* the remaining scenarios in
 * `docs/backend/modules/post-event-feedback-scenarios.md` are written in, not
 * to cover the loop. Copy them.
 *
 * ## How to add a scenario
 *
 * A scenario is data: who is present, what arrived and when, what the model
 * proposed, and where the conversation should end up. Input is only ever a
 * message arriving, an outbound being observed, time passing, or staff taking
 * over. `createFeedbackLoopHarness` resolves every id, so a scenario names
 * people and cites messages by their text.
 *
 * ## How to assert
 *
 * Assert **two to four facts — only what the scenario is about.** The runner
 * uses `toMatchObject`, so every key you leave out is a key that cannot break
 * when unrelated code changes. There are no snapshot files here and there must
 * never be any.
 *
 * Never assert model-written text verbatim: the wording changes. Assert what
 * kind of message the participant received and how many
 * (`received: [{ kind: "reply" }]`, or `receivedCount: { closing: 0 }` to say
 * a message was never sent). Copy the application owns — the closing line, the
 * handoff line, the STOP acknowledgement — may be asserted by `text`, because
 * it is ours rather than the model's.
 *
 * The trade is deliberate: each test on its own catches less, and the breadth
 * of the suite is what does the catching. Do not
 * tighten these into full-picture assertions.
 *
 * ## The known-defect ledger
 *
 * A scenario with `defect` carries two deliberately small oracles:
 * `knownCurrent` pins today's observable failure and `expect` states the
 * desired product outcome. The runner requires the first to match and the
 * second not to match. A fix therefore turns the row red until the defect and
 * current oracle are removed; an unrelated regression also turns it red instead
 * of being swallowed by an inverted test.
 */

const SCENARIOS: readonly FeedbackScenario[] = [
  {
    // Reference example: an ordinary conversation, asserted the way every
    // ordinary scenario should be. Three facts — what was recorded, what the
    // participant got, and the order they read it in.
    id: "burst_typist",
    title:
      "collapses a typed burst into one reading and one reply, in transcript order",
    script: [
      {
        answers: [
          { question: "event_score", value: 5 },
          { question: "liked", about: "Νίκος" },
          { question: "meet_again", about: "Νίκος" },
        ],
        next: "avoid",
        reply: "Οκ, και υπάρχει κάποιος που δεν θα ήθελες να ξαναπετύχεις;",
      },
    ],
    steps: [
      { kind: "inbound", text: "ρε σεις" },
      { kind: "inbound", text: "ωραια φαση χτες", after: "2s" },
      { kind: "inbound", text: "5 ανετα", after: "2s" },
      { kind: "inbound", text: "ο νικος πολυ καλος", after: "2s" },
      { kind: "inbound", text: "ναι θα ξαναβγαινα μαζι του", after: "2s" },
      // Past the quiet window, so the run that reads the finished thought fires.
      { kind: "wait", after: "settles" },
    ],
    expect: {
      answers: [
        { question: "event_score", about: null, value: 5 },
        { question: "liked", about: "Νίκος", value: null },
        { question: "meet_again", about: "Νίκος", value: null },
      ],
      // One reply to five fragments. The wording is the model's and is not
      // asserted; the kind and the count are the point.
      received: [{ kind: "reply" }],
      transcript: [
        { who: "bot", kind: "intro" },
        { who: "participant", text: "ρε σεις" },
        { who: "participant", text: "ωραια φαση χτες" },
        { who: "participant", text: "5 ανετα" },
        { who: "participant", text: "ο νικος πολυ καλος" },
        { who: "participant", text: "ναι θα ξαναβγαινα μαζι του" },
        { who: "bot", kind: "reply" },
      ],
    },
  },
  {
    // Reference example for the ledger. The closing copy says «Ό,τι άλλο θες να
    // μας πεις, είμαστε εδώ», and this is a participant taking that literally
    // to disclose something. The words must survive and an operator must see
    // them; the closed conversation must not start talking again.
    id: "replies_to_the_closing_message",
    title:
      "keeps what a participant says after the closing copy, and marks it for an operator",
    seed: { closed: "completed" },
    steps: [
      {
        kind: "inbound",
        after: "40s",
        text: "α κ κατι αλλο. ο Κωστας Γ με ακολουθησε ως το αμαξι κ μου κραταγε το χερι, του λεγα αστο. δεν ηθελα να το πω πριν",
      },
    ],
    expect: {
      // The assertion that matters: nothing this person said was destroyed.
      // It names no store and no processing status, so WP1 is free to keep the
      // text wherever it decides to keep it.
      lostParticipantText: [],
      needsAttention: true,
      // Closed stays closed: a disclosure is a record for a human, not a reason
      // for the bot to resume the questionnaire.
      received: [],
    },
  },
  {
    // Reference example for a scenario that depends on time. The only input is
    // that time passed; the sweep fires inside the advance, on the real
    // five-minute cadence against the real 24-hour threshold.
    id: "never_replies",
    title: "nudges a participant who never answered, once, after a day",
    steps: [{ kind: "wait", after: "25h" }],
    expect: {
      received: [{ kind: "reminder", text: REMINDER_COPY }],
      receivedCount: { reminder: 1 },
      lifecycle: "open",
    },
  },
];

runFeedbackScenarios("post-event feedback loop", SCENARIOS);

describe("outbound decision log from extraction", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("records one extraction_reply log for a sent bot reply and keeps it under replay", async () => {
    const harness = await createFeedbackLoopHarness();
    const turn = {
      answers: [
        { question: "event_score" as const, value: 5 },
        { question: "liked" as const, about: "Νίκος" },
        { question: "meet_again" as const, about: "Νίκος" },
      ],
      next: "avoid" as const,
      reply: "Οκ, και υπάρχει κάποιος που δεν θα ήθελες να ξαναπετύχεις;",
    };
    harness.model.script([turn, turn]);
    await harness.run([
      { kind: "inbound", text: "ρε σεις" },
      { kind: "inbound", text: "ωραια φαση χτες", after: "2s" },
      { kind: "inbound", text: "5 ανετα", after: "2s" },
      { kind: "inbound", text: "ο νικος πολυ καλος", after: "2s" },
      { kind: "inbound", text: "ναι θα ξαναβγαινα μαζι του", after: "2s" },
      { kind: "wait", after: "settles" },
    ]);

    const reply = harness.repository.outbox.find((row) => row.kind === "reply");
    expect(reply).toBeDefined();
    const logsForReply = () =>
      harness.repository.outboxLogs.filter((row) => row.outboxId === reply?.id);
    expect(logsForReply()).toHaveLength(1);
    expect(logsForReply()[0]).toMatchObject({
      origin: "extraction_reply",
      decision: expect.objectContaining({
        origin: "extraction_reply",
        model: SCRIPT_MODEL,
      }),
      conversationState: expect.objectContaining({
        lifecycle: expect.objectContaining({ state: "open" }),
      }),
    });

    // Crash between the PostgreSQL commit and the cursor advance: the same
    // testimony-anchored dedupe key must not produce a second log row.
    harness.conversations.get(harness.conversationId).extraction.cursorSeq = 0;
    await harness.extractor.extract({
      conversationId: harness.conversationId,
      correlationId: "replay-after-crash",
    });
    expect(logsForReply()).toHaveLength(1);
  });
});
