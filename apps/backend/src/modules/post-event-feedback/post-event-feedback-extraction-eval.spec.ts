import type { FeedbackAnswerQuestionKey } from "@slopform/database";
import { describe, expect, it } from "vitest";

import {
  createFeedbackExtractionProposalSchema,
  feedbackExtractionGoalVerdicts,
  type FeedbackExtractionAnswerProposal,
  type FeedbackExtractionContext,
  type FeedbackExtractionProposal,
  type FeedbackExtractionSafetySignalProposal,
  type ValidatedFeedbackExtraction,
} from "./extraction/extraction.schemas.js";
import { buildFeedbackExtractionPrompt } from "./extraction/prompt.js";
import { validateFeedbackExtractionProposal } from "./extraction/validate-proposal.js";
import {
  getPostEventFeedbackExtractionFixture,
  type PostEventFeedbackExtractionFixture,
} from "./post-event-feedback-fixtures.js";
import {
  getPostEventFeedbackQuestionSet,
  type PostEventFeedbackQuestionSetVersion,
} from "./question-set.js";

type EvalProposal = Partial<Omit<FeedbackExtractionProposal, "goals">> & {
  readonly answers?: readonly FeedbackExtractionAnswerProposal[];
  readonly skippedGoals?: readonly FeedbackAnswerQuestionKey[];
};

function proposal(
  overrides: EvalProposal,
  questionSetVersion: PostEventFeedbackQuestionSetVersion = 1,
): FeedbackExtractionProposal {
  const { answers, skippedGoals, ...rest } = overrides;
  const questionKeys = getPostEventFeedbackQuestionSet(
    questionSetVersion,
  ).answerQuestions.map((question) => question.key);
  return createFeedbackExtractionProposalSchema(questionKeys).parse({
    goals: feedbackExtractionGoalVerdicts(
      {
        ...(answers ? { answered: answers } : {}),
        declined: (skippedGoals ?? []).map((questionKey) => ({
          questionKey,
          sourceMessageIds: ["m2"],
        })),
      },
      questionKeys,
    ),
    notes: [],
    nextGoal: null,
    reply: null,
    handoff: false,
    confidence: 0.9,
    ...rest,
  });
}

/**
 * The fixtures describe a conversation, not a database. This turns one into the
 * validation context: all goals pending, nothing accepted yet, replies allowed.
 */
function contextFor(
  fixture: PostEventFeedbackExtractionFixture,
  overrides: Partial<FeedbackExtractionContext> = {},
): FeedbackExtractionContext {
  const questionSet = getPostEventFeedbackQuestionSet(
    fixture.questionSetVersion,
  );
  return {
    respondentParticipantId: fixture.respondentParticipantId,
    respondentDisplayName: null,
    candidates: fixture.candidates,
    messages: fixture.messages.map((message, index) => ({
      id: message.id,
      seq: index + 1,
      actor: message.actor,
      occurredAt: new Date(Date.UTC(2026, 6, 25, 18, index * 5)).toISOString(),
      text: message.text,
    })),
    newParticipantMessageIds: fixture.messages
      .filter((message) => message.actor === "participant")
      .map((message) => message.id),
    goals: questionSet.answerQuestions.map((question, index) => ({
      key: question.key,
      ordinal: index + 1,
      prompt: questionSet.copy[question.key],
      status: "asked" as const,
    })),
    acceptedAnswers: [],
    acceptedNotes: [],
    replyAllowed: true,
    ...overrides,
  };
}

function runEval(
  fixtureId: PostEventFeedbackExtractionFixture["id"],
  modelProposal: FeedbackExtractionProposal,
  overrides: Partial<FeedbackExtractionContext> = {},
  attentionSignals: readonly FeedbackExtractionSafetySignalProposal[] = [],
): {
  fixture: PostEventFeedbackExtractionFixture;
  result: ValidatedFeedbackExtraction;
} {
  const fixture = getPostEventFeedbackExtractionFixture(fixtureId);
  const context = contextFor(fixture, overrides);
  return {
    fixture,
    result: validateFeedbackExtractionProposal(
      modelProposal,
      context,
      attentionSignals,
    ),
  };
}

describe("feedback fixture provenance and unresolved subjects", () => {
  it("shows the durable message timestamps to the extraction model", () => {
    const fixture = getPostEventFeedbackExtractionFixture("happy_path");
    const context = contextFor(fixture);
    const prompt = buildFeedbackExtractionPrompt({
      context,
      copy: getPostEventFeedbackQuestionSet(fixture.questionSetVersion).copy,
    });

    expect(prompt.user).toContain(
      `[1] at=${context.messages[0]?.occurredAt} id=m1 actor=bot:`,
    );
    expect(prompt.user).toContain(
      `[2] at=${context.messages[1]?.occurredAt} id=m2 actor=participant:`,
    );
  });

  it("two_kostas_ambiguity: an unresolved mention never becomes an answer row", () => {
    const { result } = runEval(
      "two_kostas_ambiguity",
      proposal({
        answers: [
          {
            questionKey: "liked",
            valueInt: null,
            subjectParticipantId: null,
            subjectMentionedName: "Κώστας",
            sourceMessageIds: ["m2"],
            confidence: 0.5,
          },
        ],
      }),
    );

    expect(result.answers).toEqual([]);
    expect(result.rejections).toEqual([
      { scope: "answer", reason: "unresolved_subject", questionKey: "liked" },
    ]);
  });

  it("unknown_name_subjectless_note: Ρούλα degrades to a flagged subjectless note", () => {
    const { fixture, result } = runEval(
      "unknown_name_subjectless_note",
      proposal({
        notes: [
          {
            noteType: "general",
            text: "Η Ρούλα ήταν πολύ γλυκιά και ενδιαφέρουσα.",
            subjectParticipantId: null,
            subjectMentionedName: "Ρούλα",
            sourceMessageIds: ["m2"],
            confidence: 0.6,
          },
        ],
      }),
    );

    const expected = fixture.expected.notes[0];
    expect(result.answers).toEqual([]);
    expect(result.notes).toEqual([
      {
        noteType: expected?.noteType,
        text: expected?.text,
        subjectParticipantId: null,
        sourceMessageIds: ["m2"],
        confidence: 0.6,
        flaggedForReview: true,
        unresolvedSubjectName: "Ρούλα",
      },
    ]);
    // D18: the name survives in the text and in the meta, never as a guessed id.
    expect(result.notes[0]?.text).toContain("Ρούλα");
  });

  it("unknown_name_subjectless_note: an invented candidate id is not accepted", () => {
    const { result } = runEval(
      "unknown_name_subjectless_note",
      proposal({
        answers: [
          {
            questionKey: "liked",
            valueInt: null,
            subjectParticipantId: "p-roula",
            subjectMentionedName: "Ρούλα",
            sourceMessageIds: ["m2"],
            confidence: 0.8,
          },
        ],
        notes: [
          {
            noteType: "general",
            text: "Η Ρούλα ήταν πολύ γλυκιά και ενδιαφέρουσα.",
            subjectParticipantId: "p-roula",
            subjectMentionedName: "Ρούλα",
            sourceMessageIds: ["m2"],
            confidence: 0.6,
          },
        ],
      }),
    );

    // `p-roula` is a real participant, just not a present attendee of this
    // event. That is exactly the case D16 exists for: candidates are the live
    // set, so the answer is dropped and the note degrades.
    expect(result.answers).toEqual([]);
    expect(result.notes[0]).toMatchObject({
      subjectParticipantId: null,
      flaggedForReview: true,
      unresolvedSubjectName: "Ρούλα",
    });
    expect(result.rejections).toContainEqual({
      scope: "answer",
      reason: "unresolved_subject",
      questionKey: "liked",
    });
  });
});
