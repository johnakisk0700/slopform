import { describe, expect, it } from "vitest";

import {
  FEEDBACK_SUMMARY_LIST_ITEM_MAX,
  buildFeedbackCampaignSummaryDocument,
  parseFeedbackCampaignSummaryDocument,
  serializeFeedbackCampaignSummaryDocument,
} from "./summary-document.js";

describe("feedback campaign summary document", () => {
  it("keeps per-field list ceilings instead of one shared max", () => {
    expect(FEEDBACK_SUMMARY_LIST_ITEM_MAX).toEqual({
      gossip: 10,
      wentWrong: 10,
      wentWell: 5,
      curiosities: 5,
      actions: 5,
    });
  });

  it("round-trips a v4 document and rejects legacy markdown", () => {
    const document = buildFeedbackCampaignSummaryDocument({
      metrics: {
        questionSetVersion: 2,
        scores: [
          {
            questionKey: "event_score",
            label: "Συνολική αξιολόγηση βραδιάς",
            answerCount: 2,
            average: 4,
            max: 5,
            distribution: [
              { value: 5, count: 1 },
              { value: 4, count: 0 },
              { value: 3, count: 1 },
              { value: 2, count: 0 },
              { value: 1, count: 0 },
            ],
          },
        ],
        directed: [],
      },
      narrative: {
        curiosities: ["Κάποιος βαθμολόγησε 1 τη συζήτηση και 5 τη βραδιά."],
        gossip: ["Δύο φωνές είπαν ότι ο Νίκος «έκλεψε» το τραπέζι."],
        actions: [],
        wentWell: [{ text: "Scores stayed high.", weight: "medium" }],
        wentWrong: [
          { text: "One guest flagged racist remarks.", weight: "high" },
        ],
        missing: null,
      },
    });

    const body = serializeFeedbackCampaignSummaryDocument(document);
    expect(parseFeedbackCampaignSummaryDocument(body)).toEqual(document);
    expect(
      parseFeedbackCampaignSummaryDocument("### 📊 Η βραδιά σε νούμερα"),
    ).toBeNull();
    expect(parseFeedbackCampaignSummaryDocument(null)).toBeNull();
  });

  it("projects a stored v3 body into weighted findings at medium", () => {
    const legacyBody = JSON.stringify({
      version: 3,
      metrics: {
        questionSetVersion: 2,
        scores: [],
        directed: [],
      },
      curiosities: ["Odd skew."],
      gossip: ["Tea."],
      actions: [],
      wentWell: ["Scores stayed high."],
      wentWrong: ["Low table_fit from two people."],
      missing: null,
    });

    expect(parseFeedbackCampaignSummaryDocument(legacyBody)).toEqual({
      version: 4,
      metrics: {
        questionSetVersion: 2,
        scores: [],
        directed: [],
      },
      curiosities: ["Odd skew."],
      gossip: ["Tea."],
      actions: [],
      wentWell: [{ text: "Scores stayed high.", weight: "medium" }],
      wentWrong: [{ text: "Low table_fit from two people.", weight: "medium" }],
      missing: null,
    });
  });

  it("projects a stored v2 highlights body into curiosities", () => {
    const legacyBody = JSON.stringify({
      version: 2,
      metrics: {
        questionSetVersion: 2,
        scores: [],
        directed: [],
      },
      highlights: ["Strong table energy."],
      actions: ["Seat the quiet pair together next time."],
      wentWell: ["Scores stayed high."],
      wentWrong: [],
      missing: null,
    });

    expect(parseFeedbackCampaignSummaryDocument(legacyBody)).toEqual({
      version: 4,
      metrics: {
        questionSetVersion: 2,
        scores: [],
        directed: [],
      },
      curiosities: ["Strong table energy."],
      gossip: [],
      actions: ["Seat the quiet pair together next time."],
      wentWell: [{ text: "Scores stayed high.", weight: "medium" }],
      wentWrong: [],
      missing: null,
    });
  });
});
