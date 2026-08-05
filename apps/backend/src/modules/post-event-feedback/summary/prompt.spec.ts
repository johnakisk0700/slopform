import type {
  FeedbackAnswerRow,
  FeedbackNoteRow,
  ParticipantRow,
} from "@join-the-six/database";
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
    expect(prompt).toContain("Κράτα χωριστές τις τέσσερις βαθμολογίες");
    expect(prompt).not.toContain("Το liked είναι η απάντηση V1");
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
    expect(prompt).not.toContain("Κράτα χωριστές τις τέσσερις βαθμολογίες");
    expect(prompt).not.toContain("Καταλληλότητα παρέας και τραπεζιού");
  });

  it("asks for structured list fields and soft limits on either question set", () => {
    for (const questionSet of [
      POST_EVENT_FEEDBACK_QUESTION_SET_V1,
      POST_EVENT_FEEDBACK_QUESTION_SET_V2,
    ]) {
      const prompt = buildPrompt({
        questionSetVersion: questionSet.version,
        questionDefinitions: questionSet.answerQuestions,
        answers: [answer("event_score", 5)],
      });

      expect(prompt).toContain("`curiosities`");
      expect(prompt).toContain("`gossip`");
      expect(prompt).toContain("Κουτσομπολιό");
      expect(prompt).toContain("Αξιοπερίεργα");
      expect(prompt).toContain("`gossip` έως 10");
      expect(prompt).toContain("`wentWrong` έως 10");
      expect(prompt).toContain("`wentWell` έως 5");
      expect(prompt).toContain("`curiosities` έως 5");
      expect(prompt).toContain("`actions` έως 5");
      expect(prompt).toContain("μην σταματάς στις 3 γραμμές");
      expect(prompt).toContain("`actions`");
      expect(prompt).toContain("`wentWell`");
      expect(prompt).toContain("`wentWrong`");
      expect(prompt).toContain("{ text, weight }");
      expect(prompt).toContain("`low`|`medium`|`high`");
      expect(prompt).toContain("μην βαφτίζεις κάθε γραμμή `high`");
      expect(prompt).not.toContain("έως τρεις");
      expect(prompt).toContain("## Φωνή");
      expect(prompt).toContain("καθημερινά ελληνικά");
      expect(prompt).toContain("stand-up");
      expect(prompt).toContain("μαλακίτσες");
      expect(prompt).not.toContain("θείτσα");
      expect(prompt).toContain("είναι ρατσιστής/ρατσίστρια");
      expect(prompt).toContain("Μην κόβεις juicy gossip");
      expect(prompt).toContain("κάθε στοιχείο περίπου μία γραμμή");
      expect(prompt).not.toContain("Όλη η αναφορά κάτω από 200 λέξεις");
      expect(prompt).not.toContain("έως 20 λέξεις");
      expect(prompt).toContain("Κάθε γεγονός λέγεται μία φορά");
      expect(prompt).toContain("Χωρίς emoji");
      expect(prompt).toContain("Νούμερα (ήδη μετρημένα");
      expect(prompt).not.toContain("```chart");
      expect(prompt).not.toContain("### 📊 Η βραδιά σε νούμερα");
      expect(prompt).not.toContain("Δομή: σύντομη επισκόπηση");
      expect(prompt).not.toContain(
        "Γράψε στα ελληνικά για operator που έχει τριάντα δευτερόλεπτα.",
      );
    }
  });

  it("asks what is still missing only when the campaign is partial", () => {
    const base = {
      questionSetVersion: POST_EVENT_FEEDBACK_QUESTION_SET_V2.version,
      questionDefinitions: POST_EVENT_FEEDBACK_QUESTION_SET_V2.answerQuestions,
      answers: [answer("event_score", 4)],
    };

    const partial = buildPrompt({
      ...base,
      isPartial: true,
      openConversationCount: 2,
      closedConversationCount: 4,
    });
    const complete = buildPrompt({
      ...base,
      isPartial: false,
      openConversationCount: 0,
      closedConversationCount: 6,
    });

    expect(partial).toContain(
      "`missing`: μία γραμμή για το τι δεν καλύπτεται ακόμη επειδή υπάρχουν ανοιχτές συζητήσεις.",
    );
    expect(complete).toContain("αλλιώς null");
    expect(complete).not.toContain(
      "`missing`: μία γραμμή για το τι δεν καλύπτεται ακόμη επειδή υπάρχουν ανοιχτές συζητήσεις.",
    );
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
    expect(prompt).toContain("`wentWrong`");
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
