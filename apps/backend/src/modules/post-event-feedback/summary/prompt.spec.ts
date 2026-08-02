import type { FeedbackAnswerRow, ParticipantRow } from "@join-the-six/database";
import { describe, expect, it } from "vitest";

import {
  POST_EVENT_FEEDBACK_QUESTION_SET_V1,
  POST_EVENT_FEEDBACK_QUESTION_SET_V2,
} from "../question-set.js";
import { buildFeedbackCampaignSummaryPrompt } from "./prompt.js";

const campaignId = "89eccaa5-9ce6-4dcf-a630-5e35e4ec6f0d";
const conversationId = "11111111-1111-4111-8111-111111111111";
const respondentId = "22222222-2222-4222-8222-222222222222";
const subjectId = "33333333-3333-4333-8333-333333333333";

describe("buildFeedbackCampaignSummaryPrompt", () => {
  it("keeps V2 experience dimensions separate and renders every score over five", () => {
    const prompt = buildFeedbackCampaignSummaryPrompt({
      questionSetVersion: POST_EVENT_FEEDBACK_QUESTION_SET_V2.version,
      questionDefinitions: POST_EVENT_FEEDBACK_QUESTION_SET_V2.answerQuestions,
      isPartial: false,
      openConversationCount: 0,
      closedConversationCount: 1,
      answers: [
        answer("event_score", 5),
        answer("table_fit", 4),
        answer("participation_ease", 3),
        answer("conversation_balance", 2),
      ],
      notes: [],
      displayNames: new Map<string, ParticipantRow>(),
    });

    expect(prompt).toContain("Συνολική αξιολόγηση βραδιάς (5/5)");
    expect(prompt).toContain("Καταλληλότητα παρέας και τραπεζιού (4/5)");
    expect(prompt).toContain("Ευκολία συμμετοχής στη συζήτηση (3/5)");
    expect(prompt).toContain("Ισορροπία συμμετοχής στη συζήτηση (2/5)");
    expect(prompt).toContain("Κράτησε χωριστές τις τέσσερις βαθμολογίες");
    expect(prompt).not.toContain("Το liked είναι η απάντηση V1");
  });

  it("preserves V1 liked, meet-again, and avoid semantics without V2 dimensions", () => {
    const prompt = buildFeedbackCampaignSummaryPrompt({
      questionSetVersion: POST_EVENT_FEEDBACK_QUESTION_SET_V1.version,
      questionDefinitions: POST_EVENT_FEEDBACK_QUESTION_SET_V1.answerQuestions,
      isPartial: false,
      openConversationCount: 0,
      closedConversationCount: 1,
      answers: [
        answer("event_score", 4),
        answer("liked", null, subjectId),
        answer("meet_again", null, subjectId),
        answer("avoid", null, subjectId),
      ],
      notes: [],
      displayNames: new Map<string, ParticipantRow>(),
    });

    expect(prompt).toContain("Αναλύεις campaign με ερωτηματολόγιο V1");
    expect(prompt).toContain("Συνολική βαθμολογία βραδιάς (4/5)");
    expect(prompt).toContain("Άτομο που του/της έκανε ιδιαίτερα καλή εντύπωση");
    expect(prompt).toContain("Θα προτιμούσε να μην τον/την ξαναπετύχει");
    expect(prompt).toContain(
      "Κράτησέ το χωριστά από το meet_again, που είναι πρόθεση μελλοντικής επαφής",
    );
    expect(prompt).toContain("Μην κατατάσσεις ανθρώπους");
    expect(prompt).toContain(
      "Μην το παρουσιάζεις ως καταγγελία, παράπτωμα, κίνδυνο ή αξιολόγηση χαρακτήρα",
    );
    expect(prompt).toContain(
      "Η απουσία directed απάντησης είναι άγνωστο, όχι αρνητική ψήφος",
    );
    expect(prompt).not.toContain("Κράτησε χωριστές τις τέσσερις βαθμολογίες");
    expect(prompt).not.toContain("Καταλληλότητα παρέας και τραπεζιού");
  });
});

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
