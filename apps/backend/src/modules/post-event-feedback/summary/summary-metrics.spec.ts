import type { FeedbackAnswerRow } from "@slopform/database";
import { describe, expect, it } from "vitest";

import {
  POST_EVENT_FEEDBACK_QUESTION_SET_V1,
  POST_EVENT_FEEDBACK_QUESTION_SET_V2,
} from "../question-set.js";
import { buildFeedbackCampaignSummaryMetrics } from "./summary-metrics.js";

const campaignId = "89eccaa5-9ce6-4dcf-a630-5e35e4ec6f0d";
const conversationId = "11111111-1111-4111-8111-111111111111";
const respondentA = "22222222-2222-4222-8222-222222222222";
const respondentB = "33333333-3333-4333-8333-333333333333";
const subjectId = "44444444-4444-4444-8444-444444444444";

describe("buildFeedbackCampaignSummaryMetrics", () => {
  it("averages V2 score dimensions and counts directed edges without ranking people", () => {
    const metrics = buildFeedbackCampaignSummaryMetrics({
      questionSetVersion: POST_EVENT_FEEDBACK_QUESTION_SET_V2.version,
      questionDefinitions: POST_EVENT_FEEDBACK_QUESTION_SET_V2.answerQuestions,
      answers: [
        answer(respondentA, "event_score", 5),
        answer(respondentB, "event_score", 3),
        answer(respondentA, "table_fit", 4),
        answer(respondentA, "meet_again", null, subjectId),
        answer(respondentB, "meet_again", null, subjectId),
        answer(respondentA, "avoid", null, subjectId),
      ],
    });

    expect(metrics.questionSetVersion).toBe(2);
    expect(metrics.scores).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          questionKey: "event_score",
          answerCount: 2,
          average: 4,
          max: 5,
          distribution: expect.arrayContaining([
            { value: 5, count: 1 },
            { value: 3, count: 1 },
            { value: 4, count: 0 },
          ]),
        }),
        expect.objectContaining({
          questionKey: "table_fit",
          answerCount: 1,
          average: 4,
        }),
        expect.objectContaining({
          questionKey: "participation_ease",
          answerCount: 0,
          average: null,
        }),
      ]),
    );
    expect(metrics.directed).toEqual(
      expect.arrayContaining([
        {
          questionKey: "meet_again",
          label: "Θα χαιρόταν να ξαναβρεθεί",
          edgeCount: 2,
          respondentCount: 2,
        },
        {
          questionKey: "avoid",
          label: "Προτίμηση να μη βρεθούν ξανά στο ίδιο τραπέζι",
          edgeCount: 1,
          respondentCount: 1,
        },
      ]),
    );
    expect(JSON.stringify(metrics)).not.toContain(subjectId);
  });

  it("keeps V1 liked separate from meet_again and only scores event_score", () => {
    const metrics = buildFeedbackCampaignSummaryMetrics({
      questionSetVersion: POST_EVENT_FEEDBACK_QUESTION_SET_V1.version,
      questionDefinitions: POST_EVENT_FEEDBACK_QUESTION_SET_V1.answerQuestions,
      answers: [
        answer(respondentA, "event_score", 4),
        answer(respondentA, "liked", null, subjectId),
        answer(respondentA, "meet_again", null, subjectId),
      ],
    });

    expect(metrics.scores).toHaveLength(1);
    expect(metrics.scores[0]).toMatchObject({
      questionKey: "event_score",
      average: 4,
      answerCount: 1,
    });
    expect(metrics.directed.map((item) => item.questionKey).sort()).toEqual([
      "avoid",
      "liked",
      "meet_again",
    ]);
    expect(
      metrics.directed.find((item) => item.questionKey === "liked"),
    ).toMatchObject({ edgeCount: 1, respondentCount: 1 });
  });
});

function answer(
  respondentParticipantId: string,
  questionKey: FeedbackAnswerRow["questionKey"],
  valueInt: number | null,
  subjectParticipantId: string | null = null,
): FeedbackAnswerRow {
  return {
    id: crypto.randomUUID(),
    campaignId,
    conversationId,
    respondentParticipantId,
    subjectParticipantId,
    questionKey,
    valueInt,
    sourceMessageIds: ["55555555-5555-4555-8555-555555555555"],
    extractionMeta: { candidateIds: subjectParticipantId ? [subjectId] : [] },
    matchingHold: false,
    createdAt: new Date("2026-08-02T12:00:00.000Z"),
    updatedAt: new Date("2026-08-02T12:00:00.000Z"),
  };
}
