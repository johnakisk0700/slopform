import { describe, expect, it } from "vitest";

import { buildFeedbackExtractionPrompt } from "../extraction/prompt.js";
import type { FeedbackExtractionContext } from "../extraction/extraction.schemas.js";
import { FeedbackExtractionGenerationError } from "../extraction/model.service.js";
import { POST_EVENT_FEEDBACK_QUESTION_SET_V1 } from "../question-set.js";
import type { BurstPersona } from "./burst-scenario.js";
import { parseBurstExtractionPrompt } from "./parse-burst-extraction-prompt.js";
import {
  matchBurstPersona,
  resolveCite,
  ScriptedBurstExtractionModel,
} from "./scripted-extraction-model.service.js";

const COPY = POST_EVENT_FEEDBACK_QUESTION_SET_V1.copy;

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
      { afterMs: 0, text: "πέντε" },
      { afterMs: 2_000, text: "μου άρεσε ο Νίκος" },
    ],
    stub: [
      {
        answers: [
          { question: "event_score", value: 5, cite: "all-new" },
          { question: "liked", about: "Νίκος Παπαδόπουλος", cite: "last" },
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
        key: "liked",
        ordinal: 2,
        prompt: "liked",
        status: "pending",
      },
      {
        key: "meet_again",
        ordinal: 3,
        prompt: "meet",
        status: "pending",
      },
      {
        key: "avoid",
        ordinal: 4,
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
        text: "πέντε",
      },
      {
        id: "msg-p-2",
        seq: 3,
        actor: "participant",
        occurredAt: "2026-07-27T10:00:14.000Z",
        text: "μου άρεσε ο Νίκος",
      },
    ],
    newParticipantMessageIds: ["msg-p-1", "msg-p-2"],
    ...overrides,
  };
}

describe("parseBurstExtractionPrompt", () => {
  it("recovers candidates, new ids and transcript text from a realistic prompt", () => {
    const prompt = buildFeedbackExtractionPrompt({
      context: context(),
      copy: COPY,
    });
    const parsed = parseBurstExtractionPrompt(prompt.user);

    expect(parsed.candidates).toEqual([
      {
        participantId: "cand-nikos",
        displayName: "Νίκος Παπαδόπουλος",
      },
      { participantId: "cand-eleni", displayName: "Ελένη" },
    ]);
    expect(parsed.newMessageIds).toEqual(["msg-p-1", "msg-p-2"]);
    expect(parsed.transcript).toEqual([
      {
        seq: 1,
        occurredAt: "2026-07-27T10:00:00.000Z",
        id: "msg-bot-1",
        actor: "bot",
        text: "Πώς σου φάνηκε η βραδιά από το 1 έως το 5;",
      },
      {
        seq: 2,
        occurredAt: "2026-07-27T10:00:12.000Z",
        id: "msg-p-1",
        actor: "participant",
        text: "πέντε",
      },
      {
        seq: 3,
        occurredAt: "2026-07-27T10:00:14.000Z",
        id: "msg-p-2",
        actor: "participant",
        text: "μου άρεσε ο Νίκος",
      },
    ]);
  });
});

describe("resolveCite", () => {
  it("maps cite tokens onto the run's new message ids", () => {
    const ids = ["msg-a", "msg-b", "msg-c"] as const;
    expect(resolveCite("all-new", ids)).toEqual(["msg-a", "msg-b", "msg-c"]);
    expect(resolveCite("first", ids)).toEqual(["msg-a"]);
    expect(resolveCite("last", ids)).toEqual(["msg-c"]);
  });
});

describe("ScriptedBurstExtractionModel", () => {
  it("throws when new messages match no persona", async () => {
    const model = new ScriptedBurstExtractionModel([persona()]);
    const prompt = buildFeedbackExtractionPrompt({
      context: context({
        messages: [
          {
            id: "msg-p-1",
            seq: 1,
            actor: "participant",
            occurredAt: "2026-07-27T10:00:00.000Z",
            text: "unrelated text",
          },
        ],
        newParticipantMessageIds: ["msg-p-1"],
      }),
      copy: COPY,
    });

    await expect(model.propose(prompt)).rejects.toBeInstanceOf(
      FeedbackExtractionGenerationError,
    );
  });

  it("throws when new messages match two personas", () => {
    const shared = "κοινό μήνυμα";
    expect(() =>
      matchBurstPersona(
        [
          persona({ id: "a", messages: [{ afterMs: 0, text: shared }] }),
          persona({ id: "b", messages: [{ afterMs: 0, text: shared }] }),
        ],
        [shared],
      ),
    ).toThrow(/multiple personas/);
  });

  it("throws when the scripted stub is exhausted", async () => {
    const model = new ScriptedBurstExtractionModel([
      persona({ stub: [{ reply: "μία φορά" }] }),
    ]);
    const first = buildFeedbackExtractionPrompt({
      context: context(),
      copy: COPY,
    });
    await model.propose(first);

    const second = buildFeedbackExtractionPrompt({
      context: context({
        messages: [
          {
            id: "msg-p-3",
            seq: 4,
            actor: "participant",
            occurredAt: "2026-07-27T10:01:00.000Z",
            text: "πέντε",
          },
        ],
        newParticipantMessageIds: ["msg-p-3"],
      }),
      copy: COPY,
    });

    await expect(model.propose(second)).rejects.toThrow(/exhausted/);
  });

  it("resolves about names and cite tokens through propose", async () => {
    const model = new ScriptedBurstExtractionModel([persona()]);
    const prompt = buildFeedbackExtractionPrompt({
      context: context(),
      copy: COPY,
    });

    const result = await model.propose(prompt);
    expect(result.usage).toEqual({
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
    });
    expect(result.proposal.goals).toEqual({
      event_score: {
        status: "answered",
        answers: [
          {
            valueInt: 5,
            subjectParticipantId: null,
            subjectMentionedName: null,
            sourceMessageIds: ["msg-p-1", "msg-p-2"],
            confidence: 0.9,
          },
        ],
        declinedSourceMessageIds: [],
      },
      liked: {
        status: "answered",
        answers: [
          {
            valueInt: null,
            subjectParticipantId: "cand-nikos",
            subjectMentionedName: null,
            sourceMessageIds: ["msg-p-2"],
            confidence: 0.9,
          },
        ],
        declinedSourceMessageIds: [],
      },
      // Stated, not absent. The two goals this turn said nothing about are the
      // whole reason the shape is a verdict per goal rather than a list.
      meet_again: {
        status: "not_addressed",
        answers: [],
        declinedSourceMessageIds: [],
      },
      avoid: {
        status: "not_addressed",
        answers: [],
        declinedSourceMessageIds: [],
      },
    });
  });

  it("reuses the same claimed turn for concurrent attention classification", async () => {
    const model = new ScriptedBurstExtractionModel([persona()]);
    const extractionContext = context();
    const prompt = buildFeedbackExtractionPrompt({
      context: extractionContext,
      copy: COPY,
    });

    const [proposed, attention] = await Promise.all([
      model.propose(prompt),
      model.classifyAttention(
        extractionContext.messages,
        extractionContext.newParticipantMessageIds,
      ),
    ]);

    expect(
      Object.values(proposed.proposal.goals).filter(
        (verdict) => verdict.status === "answered",
      ),
    ).toHaveLength(2);
    expect(attention.signals).toEqual([]);
    expect(attention.usage.inputTokens).toBeNull();
    expect(attention.estimatedPromptTokens).toBe(0);
  });
});
