import { describe, expect, it } from "vitest";

import type { FeedbackConversationGoal } from "../post-event-feedback-conversation.document.js";
import type {
  FeedbackExtractionContext,
  ValidatedFeedbackExtraction,
} from "./extraction.schemas.js";
import {
  isCompleting,
  isWithdrawal,
  nextOpenGoal,
  resolveGoalStatuses,
  withAskedGoal,
  withSettledOpenGoals,
} from "./goal-progress.js";

const goals: FeedbackConversationGoal[] = [
  { key: "event_score", ordinal: 1, prompt: "score", status: "asked" },
  { key: "liked", ordinal: 2, prompt: "liked", status: "pending" },
  { key: "meet_again", ordinal: 3, prompt: "meet", status: "pending" },
  { key: "avoid", ordinal: 4, prompt: "avoid", status: "pending" },
];

function context(
  overrides: Partial<FeedbackExtractionContext> = {},
): FeedbackExtractionContext {
  return {
    respondentParticipantId: "p-respondent",
    respondentDisplayName: "Μαρία",
    candidates: [],
    messages: [],
    newParticipantMessageIds: [],
    goals,
    acceptedAnswers: [],
    acceptedNotes: [],
    replyAllowed: true,
    ...overrides,
  };
}

function validated(
  overrides: Partial<ValidatedFeedbackExtraction> = {},
): ValidatedFeedbackExtraction {
  return {
    answers: [],
    notes: [],
    skippedGoals: [],
    nextGoal: null,
    reply: null,
    replySuppressedReason: null,
    safetySignals: [],
    handoff: false,
    confidence: 0.9,
    rejections: [],
    ...overrides,
  };
}

describe("goal progress from recorded results", () => {
  it("does not mark the model's nextGoal as asked — that belongs to the outbound", () => {
    const updates = resolveGoalStatuses(
      goals,
      context({
        acceptedAnswers: [
          {
            questionKey: "event_score",
            subjectParticipantId: null,
            valueInt: 5,
          },
        ],
      }),
      validated({
        nextGoal: "liked",
        reply: "Τέλεια! Ποιος σου άρεσε;",
      }),
    );

    expect(updates).toEqual([{ key: "event_score", status: "answered" }]);
    expect(nextOpenGoal(goals, updates)).toBe("liked");
  });

  it("is not completing when directed answers were refused and only the score landed", () => {
    const updates = resolveGoalStatuses(
      goals,
      context({
        acceptedAnswers: [
          {
            questionKey: "event_score",
            subjectParticipantId: null,
            valueInt: 5,
          },
        ],
      }),
      validated({
        // Model believed liked / meet_again / avoid were done; none survived.
        nextGoal: null,
        reply: "Ευχαριστούμε για το feedback 🙂",
      }),
    );

    expect(isCompleting(goals, updates)).toBe(false);
    expect(nextOpenGoal(goals, updates)).toBe("liked");
  });

  it("records asked from the outbound's goal, not from the model's proposal", () => {
    const recorded = resolveGoalStatuses(
      goals,
      context(),
      validated({
        nextGoal: "liked",
        reply: "Τέλεια, το σημείωσα!",
      }),
    );

    expect(withAskedGoal(recorded, "event_score")).toEqual([
      { key: "event_score", status: "asked" },
    ]);
  });

  it("settles every open goal when the bot withdraws without asking", () => {
    // Πάνος Μούλαρος: «Εντάξει, το άξιζα 😅 Δεν θα σε ζαλίσω άλλο» — no
    // answers, no notes, no question, yet nextGoal still named. Without
    // settling, the ladder stays open and the reminder chase continues after
    // he was told it was over.
    const recorded = resolveGoalStatuses(goals, context(), validated());
    const settled = withSettledOpenGoals(goals, recorded);

    expect(
      isWithdrawal({
        answers: [],
        notes: [],
        nextGoal: "liked",
        askedGoal: undefined,
        outboundSent: true,
      }),
    ).toBe(true);
    expect(settled).toEqual([
      { key: "event_score", status: "skipped" },
      { key: "liked", status: "skipped" },
      { key: "meet_again", status: "skipped" },
      { key: "avoid", status: "skipped" },
    ]);
    expect(isCompleting(goals, settled)).toBe(true);
  });

  it("does not treat a re-ask with nothing to extract as a withdrawal", () => {
    // Ordinary turn: participant said nothing usable, bot still posed the
    // open question. The ladder must stay open — that is still going, not
    // backing off.
    expect(
      isWithdrawal({
        answers: [],
        notes: [],
        nextGoal: "event_score",
        askedGoal: "event_score",
        outboundSent: true,
      }),
    ).toBe(false);
    const updates = withAskedGoal([], "event_score");
    expect(isCompleting(goals, updates)).toBe(false);
    expect(nextOpenGoal(goals, updates)).toBe("event_score");
  });

  it("does not treat a side-question reply as a withdrawal", () => {
    // Flirting / "who reads this": nextGoal null, statement reply, nothing
    // extracted. The questionnaire continues — that is not backing off.
    expect(
      isWithdrawal({
        answers: [],
        notes: [],
        nextGoal: null,
        askedGoal: undefined,
        outboundSent: true,
      }),
    ).toBe(false);
  });

  it("does not treat a replay of already-stored results as a withdrawal", () => {
    // Crash after PostgreSQL commit: validation refuses the duplicates, the
    // accepted lists are empty, and a statement reply has no askedGoal. Without
    // the repair signal that would settle the ladder and close.
    expect(
      isWithdrawal({
        answers: [],
        notes: [],
        nextGoal: "liked",
        askedGoal: undefined,
        outboundSent: true,
        repairingStoredResults: true,
      }),
    ).toBe(false);
  });
});
