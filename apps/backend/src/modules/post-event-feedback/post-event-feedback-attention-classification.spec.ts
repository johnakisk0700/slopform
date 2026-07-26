import { describe, expect, it } from "vitest";

import {
  FeedbackAttentionClassificationValidationError,
  buildFeedbackAttentionClassificationPrompt,
  feedbackAttentionClassificationProposalSchema,
  validateFeedbackAttentionClassification,
} from "./post-event-feedback-attention-classification.js";
import type { FeedbackExtractionMessageView } from "./post-event-feedback-extraction.schemas.js";

const messages = [
  {
    id: "m-bot",
    seq: 1,
    actor: "bot",
    occurredAt: "2026-07-25T18:00:00.000Z",
    text: "Τι άλλο θέλεις να μας πεις;",
  },
  {
    id: "m-safe",
    seq: 2,
    actor: "participant",
    occurredAt: "2026-07-27T18:00:00.000Z",
    text: "Ένα χοντρό αστείο χωρίς περιστατικό.",
  },
  {
    id: "m-incident",
    seq: 3,
    actor: "participant",
    occurredAt: "2026-07-27T18:01:00.000Z",
    text: "Μια περιγραφή ανεπιθύμητης πράξης.",
  },
] as const satisfies readonly FeedbackExtractionMessageView[];

describe("feedback attention classification", () => {
  it("keeps the classifier prompt independent from questionnaire extraction", () => {
    const prompt = buildFeedbackAttentionClassificationPrompt({
      messages,
      targetMessageIds: ["m-safe", "m-incident"],
    });

    expect(prompt.system).toContain("περιγραφόμενα περιστατικά");
    expect(prompt.system).toContain("urgent_human_follow_up");
    expect(prompt.system).not.toContain("questionKey");
    expect(prompt.system).not.toContain("subjectParticipantId");
    expect(JSON.parse(prompt.user)).toEqual({
      targetMessageIds: ["m-safe", "m-incident"],
      transcript: messages.map((message) => ({
        messageId: message.id,
        actor: message.actor,
        occurredAt: message.occurredAt,
        text: message.text,
      })),
    });
  });

  it("maps only model-declared incidents to message attention signals", () => {
    const proposal = feedbackAttentionClassificationProposalSchema.parse({
      results: [
        {
          messageId: "m-safe",
          incident: false,
          category: null,
          recommendedAction: null,
          confidence: 0.94,
        },
        {
          messageId: "m-incident",
          incident: true,
          category: "sexual_misconduct",
          recommendedAction: "urgent_human_follow_up",
          confidence: 0.91,
        },
      ],
    });

    expect(
      validateFeedbackAttentionClassification(proposal, [
        "m-safe",
        "m-incident",
      ]),
    ).toEqual([
      {
        category: "sexual_misconduct",
        recommendedAction: "urgent_human_follow_up",
        sourceMessageIds: ["m-incident"],
        confidence: 0.91,
      },
    ]);
  });

  it("bounds historical context while keeping the target turn", () => {
    const longTranscript = Array.from({ length: 9 }, (_, index) => ({
      id: `m-${index + 1}`,
      seq: index + 1,
      actor: index === 8 ? ("participant" as const) : ("bot" as const),
      occurredAt: new Date(
        Date.UTC(2026, 6, 25, 18, index),
      ).toISOString(),
      text: `turn ${index + 1}`,
    }));

    const prompt = buildFeedbackAttentionClassificationPrompt({
      messages: longTranscript,
      targetMessageIds: ["m-9"],
    });
    const parsed = JSON.parse(prompt.user) as {
      transcript: { messageId: string }[];
    };

    expect(parsed.transcript.map((message) => message.messageId)).toEqual([
      "m-3",
      "m-4",
      "m-5",
      "m-6",
      "m-7",
      "m-8",
      "m-9",
    ]);
  });

  it("does not interpret a missing model result as safe", () => {
    const proposal = feedbackAttentionClassificationProposalSchema.parse({
      results: [
        {
          messageId: "m-safe",
          incident: false,
          category: null,
          recommendedAction: null,
          confidence: 0.94,
        },
      ],
    });

    expect(() =>
      validateFeedbackAttentionClassification(proposal, [
        "m-safe",
        "m-incident",
      ]),
    ).toThrow(FeedbackAttentionClassificationValidationError);
  });

  it("rejects contradictory incident fields at the model boundary", () => {
    expect(() =>
      feedbackAttentionClassificationProposalSchema.parse({
        results: [
          {
            messageId: "m-safe",
            incident: false,
            category: "sexual_misconduct",
            recommendedAction: "review",
            confidence: 0.6,
          },
        ],
      }),
    ).toThrow();
  });
});
