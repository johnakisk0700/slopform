import { describe, expect, it } from "vitest";

import type { FeedbackConversationDocument } from "../post-event-feedback-conversation.document.js";
import type { FeedbackExtractionValidationResult } from "./validate-proposal.js";
import type { GoalStatusUpdate } from "./goal-progress.js";
import {
  adjustAfterIngressOrWorkSuppression,
  decideExtractionTurn,
  deriveTurnPolicyFacts,
  suppressCloseAfterInitialWithholding,
} from "./turn-decision.js";

const openGoals: FeedbackConversationDocument["goals"] = [
  { key: "event_score", ordinal: 1, prompt: "score", status: "asked" },
  { key: "liked", ordinal: 2, prompt: "liked", status: "pending" },
  { key: "meet_again", ordinal: 3, prompt: "meet", status: "pending" },
  { key: "avoid", ordinal: 4, prompt: "avoid", status: "pending" },
];

const answeredGoals = openGoals.map((goal) => ({
  ...goal,
  status: "answered" as const,
}));

function conversation(
  goals: FeedbackConversationDocument["goals"],
): FeedbackConversationDocument {
  return { goals } as FeedbackConversationDocument;
}

function validated(
  overrides: Partial<FeedbackExtractionValidationResult> = {},
): FeedbackExtractionValidationResult {
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
    conflictingAnswerRevision: false,
    ...overrides,
  };
}

const recordedAnswered: GoalStatusUpdate[] = answeredGoals.map((goal) => ({
  key: goal.key,
  status: "answered",
}));

describe("deriveTurnPolicyFacts", () => {
  it("keeps urgent safety ordinary while marking duty of care", () => {
    const facts = deriveTurnPolicyFacts({
      conversation: conversation(openGoals),
      validated: validated({
        safetySignals: [
          {
            category: "harassment",
            recommendedAction: "urgent_human_follow_up",
            sourceMessageIds: ["m1"],
            confidence: 0.9,
          },
        ],
      }),
      recordedStatuses: [],
      hostileTurn: false,
      stoppingForHostility: false,
    });

    expect(facts).toMatchObject({
      urgentSafety: true,
      dutyOfCare: true,
      ordinaryReply: true,
      progressClosing: false,
    });
  });

  it("does not treat handoff or hostility-stop as ordinaryReply", () => {
    expect(
      deriveTurnPolicyFacts({
        conversation: conversation(openGoals),
        validated: validated({ handoff: true }),
        recordedStatuses: [],
        hostileTurn: false,
        stoppingForHostility: false,
      }).ordinaryReply,
    ).toBe(false);
    expect(
      deriveTurnPolicyFacts({
        conversation: conversation(openGoals),
        validated: validated(),
        recordedStatuses: [],
        hostileTurn: true,
        stoppingForHostility: true,
      }).ordinaryReply,
    ).toBe(false);
  });
});

describe("decideExtractionTurn", () => {
  it("closes without outbound intent when the ladder is already complete", () => {
    const decided = decideExtractionTurn({
      conversation: conversation(answeredGoals),
      validated: validated(),
      recordedStatuses: recordedAnswered,
      askedGoal: undefined,
      hasOutboundIntent: false,
      hostileTurn: false,
      stoppingForHostility: false,
    });

    expect(decided).toMatchObject({
      withdrew: false,
      closingReason: "completed",
    });
  });

  it("withdraws when a candidate exists and does not close", () => {
    const decided = decideExtractionTurn({
      conversation: conversation(answeredGoals),
      validated: validated({ nextGoal: "liked" }),
      recordedStatuses: recordedAnswered,
      askedGoal: undefined,
      hasOutboundIntent: true,
      hostileTurn: false,
      stoppingForHostility: false,
    });

    expect(decided.withdrew).toBe(true);
    expect(decided.closingReason).toBeNull();
  });

  it("does not close over hostility stop", () => {
    const decided = decideExtractionTurn({
      conversation: conversation(answeredGoals),
      validated: validated(),
      recordedStatuses: recordedAnswered,
      askedGoal: undefined,
      hasOutboundIntent: true,
      hostileTurn: true,
      stoppingForHostility: true,
    });

    expect(decided.hostility).toBe("stopped");
    expect(decided.closingReason).toBeNull();
  });
});

describe("named close adjustments", () => {
  const closing = decideExtractionTurn({
    conversation: conversation(answeredGoals),
    validated: validated(),
    recordedStatuses: recordedAnswered,
    askedGoal: undefined,
    hasOutboundIntent: false,
    hostileTurn: false,
    stoppingForHostility: false,
  });

  it("initial withholding nulls close only for progressClosing+withheld or rewrite", () => {
    expect(
      suppressCloseAfterInitialWithholding({
        progressClosing: true,
        withheld: true,
        rewriteSuperseded: false,
        closingReason: "completed",
      }),
    ).toBeNull();
    expect(
      suppressCloseAfterInitialWithholding({
        progressClosing: false,
        withheld: true,
        rewriteSuperseded: true,
        closingReason: "completed",
      }),
    ).toBeNull();
    expect(
      suppressCloseAfterInitialWithholding({
        progressClosing: true,
        withheld: false,
        rewriteSuperseded: false,
        closingReason: closing.closingReason,
      }),
    ).toBe("completed");
  });

  it("persist ingress/work uses prior close ? null : recomputed close", () => {
    const withdrawn = decideExtractionTurn({
      conversation: conversation(answeredGoals),
      validated: validated({ nextGoal: "liked" }),
      recordedStatuses: recordedAnswered,
      askedGoal: undefined,
      hasOutboundIntent: true,
      hostileTurn: false,
      stoppingForHostility: false,
    });
    const withoutIntent = decideExtractionTurn({
      conversation: conversation(answeredGoals),
      validated: validated({ nextGoal: "liked" }),
      recordedStatuses: recordedAnswered,
      askedGoal: undefined,
      hasOutboundIntent: false,
      hostileTurn: false,
      stoppingForHostility: false,
    });

    expect(withdrawn.closingReason).toBeNull();
    expect(withoutIntent.closingReason).toBe("completed");
    expect(
      adjustAfterIngressOrWorkSuppression(closing, withoutIntent).closingReason,
    ).toBeNull();
    expect(
      adjustAfterIngressOrWorkSuppression(withdrawn, withoutIntent),
    ).toMatchObject({
      closingReason: "completed",
      withdrew: false,
    });
  });
});
