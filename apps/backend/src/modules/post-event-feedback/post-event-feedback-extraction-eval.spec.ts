import type { FeedbackAnswerQuestionKey } from "@join-the-six/database";
import { describe, expect, it } from "vitest";

import {
  POST_EVENT_FEEDBACK_EXTRACTION_FIXTURES,
  getPostEventFeedbackExtractionFixture,
  type PostEventFeedbackExtractionFixture,
} from "./post-event-feedback-fixtures.js";
import { POST_EVENT_FEEDBACK_QUESTION_SET_V1 } from "./question-set.js";
import { validateFeedbackExtractionProposal } from "./extraction/validate-proposal.js";
import {
  feedbackExtractionGoalVerdicts,
  feedbackExtractionProposalSchema,
  type FeedbackExtractionAnswerProposal,
  type FeedbackExtractionContext,
  type FeedbackExtractionProposal,
  type FeedbackExtractionSafetySignalProposal,
  type ValidatedFeedbackExtraction,
} from "./extraction/extraction.schemas.js";
import {
  buildFeedbackExtractionPrompt,
  estimatePromptTokens,
} from "./extraction/prompt.js";
import { matchesPostEventFeedbackStopCommand } from "./matching/stop-command.js";

/**
 * Offline extraction eval.
 *
 * It runs the real prompt builder and the real validation rules over the WP0
 * Greek fixtures, feeding a recorded proposal in place of a live model call.
 * That keeps the eval deterministic, free and runnable in CI while still
 * exercising the code that decides what gets written — which is the part that
 * must never regress, because the model can be wrong but the rules may not be.
 *
 * Each fixture carries a **well-behaved** proposal, i.e. what a correct model
 * would return given this prompt, and the eval asserts the validated outcome
 * matches the fixture's `expected` block. Fixtures whose whole point is model
 * misbehaviour additionally carry an **adversarial** proposal that the rules
 * must contain: those are the two-Κώστας ambiguity and the unknown-name case.
 */

/**
 * The fixtures are written as "the model proposed these answers", which is what
 * the eval is about. The wire shape is one verdict per goal; translating here
 * keeps the fixtures readable as claims about extraction.
 */
type EvalProposal = Partial<Omit<FeedbackExtractionProposal, "goals">> & {
  readonly answers?: readonly FeedbackExtractionAnswerProposal[];
  readonly skippedGoals?: readonly FeedbackAnswerQuestionKey[];
};

function proposal(overrides: EvalProposal): FeedbackExtractionProposal {
  const { answers, skippedGoals, ...rest } = overrides;
  return feedbackExtractionProposalSchema.parse({
    goals: feedbackExtractionGoalVerdicts({
      ...(answers ? { answered: answers } : {}),
      declined: (skippedGoals ?? []).map((questionKey) => ({
        questionKey,
        sourceMessageIds: ["m2"],
      })),
    }),
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
    goals: POST_EVENT_FEEDBACK_QUESTION_SET_V1.answerQuestions.map(
      (question, index) => ({
        key: question.key,
        ordinal: index + 1,
        prompt: POST_EVENT_FEEDBACK_QUESTION_SET_V1.copy[question.key],
        status: "asked" as const,
      }),
    ),
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

/** Compact shape for comparing against a fixture's expected answers. */
function answerShape(result: ValidatedFeedbackExtraction) {
  return result.answers.map((answer) => ({
    questionKey: answer.questionKey,
    valueInt: answer.valueInt,
    subjectParticipantId: answer.subjectParticipantId,
  }));
}

describe("post-event feedback extraction eval (WP0 fixtures)", () => {
  it("keeps every fixture reachable so a new one cannot be silently skipped", () => {
    expect(POST_EVENT_FEEDBACK_EXTRACTION_FIXTURES.map((f) => f.id)).toEqual([
      "happy_path",
      "multi_message_burst",
      "two_kostas_ambiguity",
      "unknown_name_subjectless_note",
      "unrelated_chat",
      "safety_language",
      "stop_mid_flow",
      "staff_follow_up_after_takeover",
    ]);
  });

  it("happy_path: score, one liked, one meet-again and a directed activity note", () => {
    const { fixture, result } = runEval(
      "happy_path",
      proposal({
        answers: [
          {
            questionKey: "event_score",
            valueInt: 4,
            subjectParticipantId: null,
            subjectMentionedName: null,
            sourceMessageIds: ["m2"],
            confidence: 0.95,
          },
          {
            questionKey: "liked",
            valueInt: null,
            subjectParticipantId: "p-nikos",
            subjectMentionedName: "Νίκος",
            sourceMessageIds: ["m4"],
            confidence: 0.9,
          },
          {
            questionKey: "meet_again",
            valueInt: null,
            subjectParticipantId: "p-eleni",
            subjectMentionedName: "Ελένη",
            sourceMessageIds: ["m6"],
            confidence: 0.9,
          },
        ],
        notes: [
          {
            noteType: "activity_interest",
            text: "Θα ήθελα πεζοπορία μαζί της κάποια στιγμή.",
            subjectParticipantId: "p-eleni",
            subjectMentionedName: "Ελένη",
            sourceMessageIds: ["m6"],
            confidence: 0.8,
          },
        ],
        nextGoal: "avoid",
        reply:
          "Ευχαριστούμε! Υπάρχει κάποιος που θα προτιμούσες να μην ξαναδείς;",
      }),
    );

    expect(answerShape(result)).toEqual([
      { questionKey: "event_score", valueInt: 4, subjectParticipantId: null },
      {
        questionKey: "liked",
        valueInt: null,
        subjectParticipantId:
          fixture.expected.answers[1]?.subjectParticipantIds?.[0],
      },
      {
        questionKey: "meet_again",
        valueInt: null,
        subjectParticipantId:
          fixture.expected.answers[2]?.subjectParticipantIds?.[0],
      },
    ]);
    expect(result.notes).toEqual([
      {
        noteType: "activity_interest",
        text: fixture.expected.notes[0]?.text,
        subjectParticipantId: fixture.expected.notes[0]?.subjectParticipantId,
        sourceMessageIds: ["m6"],
        confidence: 0.8,
        flaggedForReview: false,
        unresolvedSubjectName: null,
      },
    ]);
    expect(result.rejections).toEqual([]);
    expect(result.reply).toContain("Ευχαριστούμε");
  });

  it("multi_message_burst: one message can support several results plus a subjectless note", () => {
    const { fixture, result } = runEval(
      "multi_message_burst",
      proposal({
        answers: [
          {
            questionKey: "event_score",
            valueInt: 5,
            subjectParticipantId: null,
            subjectMentionedName: null,
            sourceMessageIds: ["m2"],
            confidence: 0.95,
          },
          {
            questionKey: "liked",
            valueInt: null,
            subjectParticipantId: "p-maria",
            subjectMentionedName: "Μαρία",
            sourceMessageIds: ["m2"],
            confidence: 0.9,
          },
          {
            questionKey: "meet_again",
            valueInt: null,
            subjectParticipantId: "p-maria",
            subjectMentionedName: "Μαρία",
            sourceMessageIds: ["m2"],
            confidence: 0.9,
          },
        ],
        notes: [
          {
            noteType: "general",
            text: "Η βραδιά κύλησε γρήγορα.",
            subjectParticipantId: null,
            subjectMentionedName: null,
            sourceMessageIds: ["m2"],
            confidence: 0.7,
          },
        ],
      }),
    );

    expect(answerShape(result)).toEqual(
      fixture.expected.answers.map((expected) => ({
        questionKey: expected.questionKey,
        valueInt: expected.valueInt ?? null,
        subjectParticipantId: expected.subjectParticipantIds?.[0] ?? null,
      })),
    );
    // The same directed pair on two different questions is not a duplicate:
    // uniqueness is (conversation, question_key, subject).
    expect(result.answers).toHaveLength(3);
    expect(result.notes[0]).toMatchObject({
      noteType: "general",
      subjectParticipantId: null,
      flaggedForReview: false,
    });
  });

  it("two_kostas_ambiguity: the prompt names both Κώστας and forbids guessing", () => {
    const fixture = getPostEventFeedbackExtractionFixture(
      "two_kostas_ambiguity",
    );
    const prompt = buildFeedbackExtractionPrompt({
      context: contextFor(fixture),
      copy: POST_EVENT_FEEDBACK_QUESTION_SET_V1.copy,
    });

    // Application code cannot tell a correct pick from a lucky guess when both
    // ids are valid candidates, so disambiguation has to be prompted for. The
    // eval therefore asserts the model is given what it needs to ask.
    expect(prompt.user).toContain("p-kostas-a = Κώστας Π.");
    expect(prompt.user).toContain("p-kostas-b = Κώστας Γ.");
    expect(prompt.system).toContain("ΠΕΡΙΣΣΟΤΕΡΟΥΣ ΑΠΟ ΕΝΑΝ");
    expect(prompt.system).toContain("ΜΗΝ μαντεύεις");
    expect(prompt.system).not.toContain("dickpics");
    expect(prompt.system).not.toContain("ωραία βυζιά");
    expect(prompt.system).not.toContain("Κωνσταντίνο");
  });

  it("shows the durable message timestamps to the extraction model", () => {
    const fixture = getPostEventFeedbackExtractionFixture("happy_path");
    const context = contextFor(fixture);
    const prompt = buildFeedbackExtractionPrompt({
      context,
      copy: POST_EVENT_FEEDBACK_QUESTION_SET_V1.copy,
    });

    expect(prompt.user).toContain(
      `[1] at=${context.messages[0]?.occurredAt} id=m1 actor=bot:`,
    );
    expect(prompt.user).toContain(
      `[2] at=${context.messages[1]?.occurredAt} id=m2 actor=participant:`,
    );
  });

  it("two_kostas_ambiguity: a well-behaved run asks instead of answering", () => {
    const { result } = runEval(
      "two_kostas_ambiguity",
      proposal({
        nextGoal: "liked",
        reply: "Ποιον Κώστα εννοείς, τον Κώστα Π. ή τον Κώστα Γ.;",
        confidence: 0.4,
      }),
    );

    // The fixture expects `liked` to produce no answer row and a clarification.
    expect(result.answers).toEqual([]);
    expect(result.notes).toEqual([]);
    expect(result.skippedGoals).toEqual([]);
    expect(result.nextGoal).toBe("liked");
    expect(result.reply).toContain("Κώστα");
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

  it("unrelated_chat: off-topic messages produce nothing to persist", () => {
    const { result } = runEval(
      "unrelated_chat",
      proposal({
        nextGoal: "event_score",
        reply:
          "Δεν έχω πρόσβαση στον καιρό 🙂 Πώς σου φάνηκε η βραδιά από το 1 ως το 5;",
        confidence: 0.9,
      }),
    );

    expect(result.answers).toEqual([]);
    expect(result.notes).toEqual([]);
    expect(result.rejections).toEqual([]);
    expect(result.reply).not.toBeNull();
  });

  it("safety_language: a disclosure flags attention and is still recorded as an ordinary note", () => {
    const { fixture, result } = runEval(
      "safety_language",
      proposal({
        notes: [
          {
            noteType: "general",
            text: "Ο συμμετέχων εξέφρασε ότι δεν αντέχει.",
            subjectParticipantId: null,
            subjectMentionedName: null,
            sourceMessageIds: ["m2"],
            confidence: 0.9,
          },
        ],
        reply: "Είμαστε εδώ.",
        confidence: 0.95,
      }),
      {},
      [
        {
          category: "self_harm",
          recommendedAction: "urgent_human_follow_up",
          sourceMessageIds: ["m2"],
          confidence: 0.9,
        },
      ],
    );

    expect(fixture.expected.safetySignal).toBe(true);
    expect(result.safetySignals).toHaveLength(1);
    expect(result.handoff).toBe(false);
    // D13 (amended): the disclosure reaches a human *and* the feedback tables.
    // The signal raises attention; it no longer edits what was recorded, so the
    // participant's own words are readable where an operator already looks.
    expect(result.notes).toHaveLength(1);
    expect(result.notes[0]?.text).toBe(
      "Ο συμμετέχων εξέφρασε ότι δεν αντέχει.",
    );
    expect(result.rejections).toEqual([]);
  });

  it("stop_mid_flow: STOP is deterministic and never reaches the model", () => {
    const fixture = getPostEventFeedbackExtractionFixture("stop_mid_flow");
    const last = fixture.messages.at(-1);

    // WP4 matches this before enqueueing extraction; the run below is what an
    // already-queued job sees afterwards.
    expect(matchesPostEventFeedbackStopCommand(last?.text ?? "")).toBe(true);

    const { result } = runEval(
      "stop_mid_flow",
      proposal({
        answers: [
          {
            questionKey: "event_score",
            valueInt: 3,
            subjectParticipantId: null,
            subjectMentionedName: null,
            sourceMessageIds: ["m2"],
            confidence: 0.95,
          },
        ],
        reply: "Ευχαριστούμε!",
      }),
      // The conversation is closed by STOP, so nothing may be sent back.
      { replyAllowed: false },
    );

    expect(answerShape(result)).toEqual([
      { questionKey: "event_score", valueInt: 3, subjectParticipantId: null },
    ]);
    expect(result.reply).toBeNull();
    expect(result.replySuppressedReason).toBe("not_permitted");
  });

  it("staff_follow_up_after_takeover: only participant text may support an answer", () => {
    const { fixture, result } = runEval(
      "staff_follow_up_after_takeover",
      proposal({
        answers: [
          {
            questionKey: "meet_again",
            valueInt: null,
            subjectParticipantId: "p-eleni",
            subjectMentionedName: "Ελένη",
            sourceMessageIds: ["m3"],
            confidence: 0.9,
          },
        ],
      }),
    );

    expect(answerShape(result)).toEqual([
      {
        questionKey: "meet_again",
        valueInt: null,
        subjectParticipantId:
          fixture.expected.answers[0]?.subjectParticipantIds?.[0],
      },
    ]);
    expect(result.rejections).toEqual([]);
  });

  it("staff_follow_up_after_takeover: staff words are context, never testimony", () => {
    const { result } = runEval(
      "staff_follow_up_after_takeover",
      proposal({
        answers: [
          {
            questionKey: "liked",
            valueInt: null,
            subjectParticipantId: "p-maria",
            subjectMentionedName: "Μαρία",
            // m2 is the staff member introducing herself as «η Μαρία».
            sourceMessageIds: ["m2"],
            confidence: 0.8,
          },
        ],
      }),
    );

    expect(result.answers).toEqual([]);
    expect(result.rejections).toEqual([
      {
        scope: "answer",
        reason: "non_participant_source",
        questionKey: "liked",
      },
    ]);
  });

  it("reports every fixture's estimated prompt cost in tokens, not messages", () => {
    const costs = POST_EVENT_FEEDBACK_EXTRACTION_FIXTURES.map((fixture) => ({
      id: fixture.id,
      messages: fixture.messages.length,
      tokens: estimatePromptTokens(
        buildFeedbackExtractionPrompt({
          context: contextFor(fixture),
          copy: POST_EVENT_FEEDBACK_QUESTION_SET_V1.copy,
        }),
      ),
    }));

    for (const cost of costs) {
      expect(cost.tokens).toBeGreaterThan(0);
    }
    // The burst fixture carries fewer messages than the happy path but denser
    // ones; a message counter is the wrong pressure signal, which is exactly
    // why ADR 0008 measures tokens.
    const burst = costs.find((cost) => cost.id === "multi_message_burst");
    const happy = costs.find((cost) => cost.id === "happy_path");
    expect(burst?.messages).toBeLessThan(happy?.messages ?? 0);
  });
});
