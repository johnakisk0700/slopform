import { describe, expect, it } from "vitest";

import type { FeedbackConversationGoal } from "../post-event-feedback-conversation.document.js";
import type {
  FeedbackExtractionContext,
  ValidatedFeedbackExtraction,
} from "./extraction.schemas.js";
import {
  isCompleting,
  nextOpenGoal,
  resolveGoalStatuses,
  withAskedGoal,
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
});
