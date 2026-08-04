import { describe, expect, it } from "vitest";

import {
  buildFeedbackCampaignSummaryDocument,
  parseFeedbackCampaignSummaryDocument,
  serializeFeedbackCampaignSummaryDocument,
} from "./summary-document.js";

describe("feedback campaign summary document", () => {
  it("round-trips a v3 document and rejects legacy markdown", () => {
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
        wentWell: ["Scores stayed high."],
        wentWrong: [],
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
      version: 3,
      metrics: {
        questionSetVersion: 2,
        scores: [],
        directed: [],
      },
      curiosities: ["Strong table energy."],
      gossip: [],
      actions: ["Seat the quiet pair together next time."],
      wentWell: ["Scores stayed high."],
      wentWrong: [],
      missing: null,
    });
  });
});
