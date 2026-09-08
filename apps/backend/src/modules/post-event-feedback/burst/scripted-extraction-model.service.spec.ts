import { describe, expect, it } from "vitest";

import type { FeedbackExtractionContext } from "../extraction/extraction.schemas.js";
import { buildFeedbackExtractionPrompt } from "../extraction/prompt.js";
import { POST_EVENT_FEEDBACK_QUESTION_SET_V2 } from "../question-set.js";
import type { BurstPersona } from "./burst-scenario.js";
import { parseBurstExtractionPrompt } from "./parse-burst-extraction-prompt.js";
import {
  resolveStubTurnIndex,
  ScriptedBurstExtractionModel,
} from "./scripted-extraction-model.service.js";

const COPY = POST_EVENT_FEEDBACK_QUESTION_SET_V2.copy;
const V2_QUESTION_KEYS =
  POST_EVENT_FEEDBACK_QUESTION_SET_V2.answerQuestions.map(
    (question) => question.key,
  );

function persona(overrides: Partial<BurstPersona> = {}): BurstPersona {
  return {
    id: "kostas_slow",
    campaign: "taverna",
    ordinal: 1,
    firstName: "Κώστας",
    lastName: "Αργοπληκτρολογάκιας",
    quirk: "types slowly",
    mirrors: "burst_typist",
    messages: [
      { afterMs: 0, text: "συνολικά πέντε" },
      {
        afterMs: 2_000,
        text: "ταίριασμα τέσσερα, συμμετοχή πέντε, ισορροπία τρία",
      },
    ],
    stub: [
      {
        answers: [
          { question: "event_score", value: 5, cite: "all-new" },
          { question: "table_fit", value: 4, cite: "last" },
          { question: "participation_ease", value: 5, cite: "last" },
          { question: "conversation_balance", value: 3, cite: "last" },
        ],
        nextGoal: "meet_again",
        reply: "Με ποιους θα ήθελες να ξαναβρεθείς;",
      },
      {
        answers: [
          {
            question: "meet_again",
            about: "Νίκος Παπαδόπουλος",
            cite: "first",
          },
        ],
        nextGoal: null,
        reply: null,
        attention: [
          {
            categories: ["harassment"],
            action: "human_follow_up",
            on: "last",
          },
        ],
      },
    ],
    expect: {
      lifecycle: "closed",
      closedBecause: "completed",
      optedIn: true,
      answers: [],
      needsAttention: false,
      minReceived: 1,
      maxReceived: 4,
    },
    ...overrides,
  };
}

function context(
  overrides: Partial<FeedbackExtractionContext> = {},
): FeedbackExtractionContext {
  return {
    respondentParticipantId: "respondent-1",
    respondentDisplayName: "Μαρία",
    candidates: [
      {
        participantId: "cand-nikos",
        displayName: "Νίκος Παπαδόπουλος",
      },
      {
        participantId: "cand-eleni",
        displayName: "Ελένη",
      },
    ],
    goals: [
      {
        key: "event_score",
        ordinal: 1,
        prompt: "score",
        status: "asked",
      },
      {
        key: "table_fit",
        ordinal: 2,
        prompt: "table fit",
        status: "pending",
      },
      {
        key: "participation_ease",
        ordinal: 3,
        prompt: "participation ease",
        status: "pending",
      },
      {
        key: "conversation_balance",
        ordinal: 4,
        prompt: "conversation balance",
        status: "pending",
      },
      {
        key: "meet_again",
        ordinal: 5,
        prompt: "meet",
        status: "pending",
      },
      {
        key: "avoid",
        ordinal: 6,
        prompt: "avoid",
        status: "pending",
      },
    ],
    acceptedAnswers: [],
    acceptedNotes: [],
    replyAllowed: true,
    messages: [
      {
        id: "msg-bot-1",
        seq: 1,
        actor: "bot",
        occurredAt: "2026-07-27T10:00:00.000Z",
        text: "Πώς σου φάνηκε η βραδιά από το 1 έως το 5;",
      },
      {
        id: "msg-p-1",
        seq: 2,
        actor: "participant",
        occurredAt: "2026-07-27T10:00:12.000Z",
        text: "συνολικά πέντε",
      },
      {
        id: "msg-p-2",
        seq: 3,
        actor: "participant",
        occurredAt: "2026-07-27T10:00:14.000Z",
        text: "ταίριασμα τέσσερα, συμμετοχή πέντε, ισορροπία τρία",
      },
    ],
    newParticipantMessageIds: ["msg-p-1", "msg-p-2"],
    ...overrides,
  };
}

describe("parseBurstExtractionPrompt", () => {
  it("keeps later turns visible after a multiline bot safety assurance", () => {
    const prompt = buildFeedbackExtractionPrompt({
      context: context({
        messages: [
          {
            id: "msg-bot-1",
            seq: 1,
            actor: "bot",
            occurredAt: "2026-07-27T10:00:00.000Z",
            text: "Λυπάμαι που ένιωσες έτσι.\n\nΤο προώθησα ήδη στην ομάδα μας.",
          },
          {
            id: "msg-p-2",
            seq: 2,
            actor: "participant",
            occurredAt: "2026-07-27T10:02:00.000Z",
            text: "δεύτερο μήνυμα\nμε συνέχεια",
          },
        ],
        newParticipantMessageIds: ["msg-p-2"],
      }),
      copy: COPY,
    });

    const parsed = parseBurstExtractionPrompt(prompt.user);

    expect(parsed.transcript).toEqual([
      {
        seq: 1,
        occurredAt: "2026-07-27T10:00:00.000Z",
        id: "msg-bot-1",
        actor: "bot",
        text: "Λυπάμαι που ένιωσες έτσι.\n\nΤο προώθησα ήδη στην ομάδα μας.",
      },
      {
        seq: 2,
        occurredAt: "2026-07-27T10:02:00.000Z",
        id: "msg-p-2",
        actor: "participant",
        text: "δεύτερο μήνυμα\nμε συνέχεια",
      },
    ]);
    expect(parsed.newMessageIds).toEqual(["msg-p-2"]);
  });
});

describe("ScriptedBurstExtractionModel", () => {
  it("resolves a later turn identically in a fresh worker process", async () => {
    const scriptedPersona = persona({
      messages: [
        { afterMs: 0, text: "πρώτο μήνυμα" },
        { afterMs: 90_000, text: "δεύτερο μήνυμα" },
      ],
      stub: [
        { nextGoal: "event_score", reply: "πρώτη απάντηση" },
        {
          answers: [{ question: "event_score", value: 2 }],
          nextGoal: "table_fit",
          reply: "δεύτερη απάντηση",
        },
      ],
    });
    const firstPrompt = buildFeedbackExtractionPrompt({
      context: context({
        messages: [
          {
            id: "msg-p-1",
            seq: 2,
            actor: "participant",
            occurredAt: "2026-07-27T10:00:00.000Z",
            text: "πρώτο μήνυμα",
          },
        ],
        newParticipantMessageIds: ["msg-p-1"],
      }),
      copy: COPY,
    });
    const secondPrompt = buildFeedbackExtractionPrompt({
      context: context({
        messages: [
          {
            id: "msg-p-1",
            seq: 2,
            actor: "participant",
            occurredAt: "2026-07-27T10:00:00.000Z",
            text: "πρώτο μήνυμα",
          },
          {
            id: "msg-p-2",
            seq: 4,
            actor: "participant",
            occurredAt: "2026-07-27T10:02:00.000Z",
            text: "δεύτερο μήνυμα",
          },
        ],
        newParticipantMessageIds: ["msg-p-2"],
      }),
      copy: COPY,
    });

    const workerA = new ScriptedBurstExtractionModel([scriptedPersona]);
    const workerB = new ScriptedBurstExtractionModel([scriptedPersona]);
    await workerA.propose(firstPrompt, V2_QUESTION_KEYS);
    const second = await workerB.propose(secondPrompt, V2_QUESTION_KEYS);

    expect(second.proposal.goals.event_score).toMatchObject({
      status: "answered",
      answers: [{ valueInt: 2, sourceMessageIds: ["msg-p-2"] }],
    });
    expect(second.proposal.reply).toBe("δεύτερη απάντηση");
    expect(resolveStubTurnIndex(scriptedPersona, ["δεύτερο μήνυμα"])).toBe(1);
  });
});
