import type {
  FeedbackAnswerRow,
  FeedbackNoteRow,
  ParticipantRow,
} from "@slopform/database";
import { describe, expect, it } from "vitest";

import {
  POST_EVENT_FEEDBACK_QUESTION_SET_V1,
  POST_EVENT_FEEDBACK_QUESTION_SET_V2,
} from "../question-set.js";
import { buildFeedbackCampaignSummaryPrompt } from "./prompt.js";
import { buildFeedbackCampaignSummaryMetrics } from "./summary-metrics.js";

const campaignId = "89eccaa5-9ce6-4dcf-a630-5e35e4ec6f0d";
const conversationId = "11111111-1111-4111-8111-111111111111";
const respondentId = "22222222-2222-4222-8222-222222222222";
const subjectId = "33333333-3333-4333-8333-333333333333";

describe("buildFeedbackCampaignSummaryPrompt", () => {
  it("keeps V2 experience dimensions separate and renders every score over five", () => {
    const answers = [
      answer("event_score", 5),
      answer("table_fit", 4),
      answer("participation_ease", 3),
      answer("conversation_balance", 2),
    ];
    const prompt = buildPrompt({
      questionSetVersion: POST_EVENT_FEEDBACK_QUESTION_SET_V2.version,
      questionDefinitions: POST_EVENT_FEEDBACK_QUESTION_SET_V2.answerQuestions,
      answers,
    });

    expect(prompt).toContain("Συνολική αξιολόγηση βραδιάς (5/5)");
    expect(prompt).toContain("Καταλληλότητα παρέας και τραπεζιού (4/5)");
    expect(prompt).toContain("Ευκολία συμμετοχής στη συζήτηση (3/5)");
    expect(prompt).toContain("Ισορροπία συμμετοχής στη συζήτηση (2/5)");
  });

  it("preserves V1 liked, meet-again, and avoid semantics without V2 dimensions", () => {
    const answers = [
      answer("event_score", 4),
      answer("liked", null, subjectId),
      answer("meet_again", null, subjectId),
      answer("avoid", null, subjectId),
    ];
    const prompt = buildPrompt({
      questionSetVersion: POST_EVENT_FEEDBACK_QUESTION_SET_V1.version,
      questionDefinitions: POST_EVENT_FEEDBACK_QUESTION_SET_V1.answerQuestions,
      answers,
    });
    expect(prompt).toContain("Συνολική βαθμολογία βραδιάς (4/5)");
    expect(prompt).toContain("Άτομο που του/της έκανε ιδιαίτερα καλή εντύπωση");
    expect(prompt).toContain("Θα προτιμούσε να μην τον/την ξαναπετύχει");
    expect(prompt).not.toContain("Καταλληλότητα παρέας και τραπεζιού");
  });

  it("marks flagged notes and unresolved attention evidence for wentWrong", () => {
    const note = {
      id: crypto.randomUUID(),
      campaignId,
      conversationId,
      respondentParticipantId: respondentId,
      subjectParticipantId: null,
      noteType: "general" as const,
      text: "Ο Τάκης ήταν άπαιχτος",
      sourceMessageIds: ["66666666-6666-4666-8666-666666666666"],
      extractionMeta: {
        candidateIds: [],
        flaggedForReview: true,
      },
      status: "new" as const,
      createdAt: new Date("2026-08-02T12:00:00.000Z"),
      updatedAt: new Date("2026-08-02T12:00:00.000Z"),
    } satisfies FeedbackNoteRow;

    const prompt = buildPrompt({
      questionSetVersion: POST_EVENT_FEEDBACK_QUESTION_SET_V2.version,
      questionDefinitions: POST_EVENT_FEEDBACK_QUESTION_SET_V2.answerQuestions,
      answers: [answer("event_score", 2)],
      notes: [note],
      attention: [
        {
          conversationId,
          respondentParticipantId: respondentId,
          kind: "safety",
          messageExcerpt: "φοβήθηκα λίγο",
        },
      ],
    });

    expect(prompt).toContain("[flagged for review]");
    expect(prompt).toContain("θέμα ασφαλείας");
    expect(prompt).toContain("«φοβήθηκα λίγο»");
  });
});

function buildPrompt(input: {
  readonly questionSetVersion: 1 | 2;
  readonly questionDefinitions:
    | typeof POST_EVENT_FEEDBACK_QUESTION_SET_V1.answerQuestions
    | typeof POST_EVENT_FEEDBACK_QUESTION_SET_V2.answerQuestions;
  readonly answers: readonly FeedbackAnswerRow[];
  readonly notes?: readonly FeedbackNoteRow[];
  readonly isPartial?: boolean;
  readonly openConversationCount?: number;
  readonly closedConversationCount?: number;
  readonly attention?: Parameters<
    typeof buildFeedbackCampaignSummaryPrompt
  >[0]["attention"];
}): string {
  const metrics = buildFeedbackCampaignSummaryMetrics({
    questionSetVersion: input.questionSetVersion,
    questionDefinitions: input.questionDefinitions,
    answers: input.answers,
  });
  return buildFeedbackCampaignSummaryPrompt({
    questionSetVersion: input.questionSetVersion,
    questionDefinitions: input.questionDefinitions,
    isPartial: input.isPartial ?? false,
    openConversationCount: input.openConversationCount ?? 0,
    closedConversationCount: input.closedConversationCount ?? 1,
    answers: input.answers,
    notes: input.notes ?? [],
    displayNames: new Map<string, ParticipantRow>(),
    metrics,
    attention: input.attention ?? [],
  });
}

function answer(
  questionKey: FeedbackAnswerRow["questionKey"],
  valueInt: number | null,
  subjectParticipantId: string | null = null,
): FeedbackAnswerRow {
  return {
    id: crypto.randomUUID(),
    campaignId,
    conversationId,
    respondentParticipantId: respondentId,
    subjectParticipantId,
    questionKey,
    valueInt,
    sourceMessageIds: ["44444444-4444-4444-8444-444444444444"],
    extractionMeta: { candidateIds: subjectParticipantId ? [subjectId] : [] },
    matchingHold: false,
    createdAt: new Date("2026-08-02T12:00:00.000Z"),
    updatedAt: new Date("2026-08-02T12:00:00.000Z"),
  };
}
