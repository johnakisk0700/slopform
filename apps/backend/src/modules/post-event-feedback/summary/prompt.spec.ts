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

  it("asks for the same three sections and the same limits on either question set", () => {
    for (const questionSet of [
      POST_EVENT_FEEDBACK_QUESTION_SET_V1,
      POST_EVENT_FEEDBACK_QUESTION_SET_V2,
    ]) {
      const prompt = buildFeedbackCampaignSummaryPrompt({
        questionSetVersion: questionSet.version,
        questionDefinitions: questionSet.answerQuestions,
        isPartial: false,
        openConversationCount: 0,
        closedConversationCount: 1,
        answers: [answer("event_score", 5)],
        notes: [],
        displayNames: new Map<string, ParticipantRow>(),
      });

      expect(prompt).toContain("### 📊 Η βραδιά σε νούμερα");
      expect(prompt).toContain("### 💬 Τι ξεχώρισε");
      expect(prompt).toContain("### 🎯 Τι κάνουμε");
      expect(prompt).toContain("Όλη η αναφορά κάτω από 200 λέξεις");
      expect(prompt).toContain("Κάθε bullet μία γραμμή, έως 20 λέξεις");
      expect(prompt).toContain("Κάθε γεγονός λέγεται μία φορά");
      expect(prompt).toContain(
        "Emoji μόνο στους τίτλους των ενοτήτων — πουθενά μέσα στο κείμενο",
      );
      // The old open-ended briefs are what produced the padding; a second
      // structure competing with the standard one is the regression to catch.
      expect(prompt).not.toContain("Δομή: σύντομη επισκόπηση");
    }
  });

  it("asks what is still missing only when the campaign is partial", () => {
    const base = {
      questionSetVersion: POST_EVENT_FEEDBACK_QUESTION_SET_V2.version,
      questionDefinitions: POST_EVENT_FEEDBACK_QUESTION_SET_V2.answerQuestions,
      answers: [answer("event_score", 4)],
      notes: [],
      displayNames: new Map<string, ParticipantRow>(),
    };

    const partial = buildFeedbackCampaignSummaryPrompt({
      ...base,
      isPartial: true,
      openConversationCount: 2,
      closedConversationCount: 4,
    });
    const complete = buildFeedbackCampaignSummaryPrompt({
      ...base,
      isPartial: false,
      openConversationCount: 0,
      closedConversationCount: 6,
    });

    expect(partial).toContain(
      "Πρόσθεσε τελευταία ενότητα «### ⚠️ Τι λείπει» με μία γραμμή",
    );
    // On a complete campaign the fourth section is conditional, and the model
    // is told to drop it outright rather than write «τίποτα δεν λείπει».
    expect(complete).toContain("Αλλιώς παράλειψέ την τελείως");
    expect(complete).not.toContain(
      "Πρόσθεσε τελευταία ενότητα «### ⚠️ Τι λείπει» με μία γραμμή",
    );
  });

  it("offers the chart fence on both question sets and keeps it under the no-ranking rule", () => {
    for (const questionSet of [
      POST_EVENT_FEEDBACK_QUESTION_SET_V1,
      POST_EVENT_FEEDBACK_QUESTION_SET_V2,
    ]) {
      const prompt = buildFeedbackCampaignSummaryPrompt({
        questionSetVersion: questionSet.version,
        questionDefinitions: questionSet.answerQuestions,
        isPartial: false,
        openConversationCount: 0,
        closedConversationCount: 1,
        answers: [answer("event_score", 5)],
        notes: [],
        displayNames: new Map<string, ParticipantRow>(),
      });

      // The fence, its type vocabulary and the scale ceiling are the contract
      // `AssistantChart` implements; a rename on either side must fail here.
      expect(prompt).toContain("```chart");
      expect(prompt).toContain('"type":"bar"');
      expect(prompt).toContain('"data":[{"label":"5/5","value":3}');
      expect(prompt).toContain('`\"max\":5`');
      expect(prompt).toContain("`bar` (κατανομές και συγκρίσεις)");
      expect(prompt).toContain("`line` (εξέλιξη σε σειρά)");
      expect(prompt).toContain("πίνακες GitHub");
      expect(prompt).toContain(
        "Μη φτιάχνεις γράφημα με ονόματα συμμετεχόντων στους άξονες",
      );
      expect(prompt).toContain("Ένα γράφημα στην πρώτη ενότητα");
      expect(prompt).toContain("Ποτέ τρίτο");
      expect(prompt).toContain(
        "Κάθε τιμή γραφήματος βγαίνει με μέτρημα ή μέσο όρο πάνω στα δεδομένα παρακάτω",
      );
      // The chart channel is offered before the data it may only draw from.
      expect(prompt.indexOf("## Μορφή")).toBeLessThan(
        prompt.indexOf("## Απαντήσεις"),
      );
    }
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
