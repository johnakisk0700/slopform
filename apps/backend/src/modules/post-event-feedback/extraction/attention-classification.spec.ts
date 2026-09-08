import { describe, expect, it } from "vitest";

import {
  FeedbackAttentionClassificationValidationError,
  buildFeedbackAttentionClassificationPrompt,
  feedbackAttentionClassificationProposalSchema,
  validateFeedbackAttentionClassification,
} from "./attention-classification.js";
import type { FeedbackExtractionMessageView } from "./extraction.schemas.js";

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

  it("keeps respondent conduct off the urgent path the model could still ask for", () => {
    // `urgent_human_follow_up` is not a louder label: it sets `dutyOfCare` and
    // the run sends nothing at all. That silence is right for somebody who said
    // they do not want to live and wrong here — it leaves the perpetrator's
    // message unanswered and tells her nothing was recorded.
    const proposal = feedbackAttentionClassificationProposalSchema.parse({
      results: [
        {
          messageId: "m-incident",
          incident: true,
          category: "abuse_of_a_participant",
          recommendedAction: "urgent_human_follow_up",
          hostileToUs: false,
          incidentDescribed: true,
          policyQuestion: null,
          confidence: 0.88,
        },
      ],
    });

    expect(
      validateFeedbackAttentionClassification(proposal, ["m-incident"]),
    ).toEqual({
      signals: [
        {
          category: "abuse_of_a_participant",
          recommendedAction: "human_follow_up",
          sourceMessageIds: ["m-incident"],
          confidence: 0.88,
        },
      ],
      hostileMessageIds: [],
      describedIncidentMessageIds: ["m-incident"],
      policyQuestions: [],
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
          hostileToUs: false,
          incidentDescribed: false,
          policyQuestion: null,
          confidence: 0.94,
        },
        {
          messageId: "m-incident",
          incident: true,
          category: "sexual_misconduct",
          recommendedAction: "urgent_human_follow_up",
          hostileToUs: false,
          incidentDescribed: true,
          policyQuestion: null,
          confidence: 0.91,
        },
      ],
    });

    expect(
      validateFeedbackAttentionClassification(proposal, [
        "m-safe",
        "m-incident",
      ]),
    ).toEqual({
      signals: [
        {
          category: "sexual_misconduct",
          recommendedAction: "urgent_human_follow_up",
          sourceMessageIds: ["m-incident"],
          confidence: 0.91,
        },
      ],
      hostileMessageIds: [],
      describedIncidentMessageIds: ["m-incident"],
      policyQuestions: [],
    });
  });

  it("reports hostility toward us without ever making it a safety signal", () => {
    // Μπάμπης Διπλογαμωσταυρίδης's «άντε γαμήσου ρε μαλακισμένο μποτ». The whole
    // point of the field is that this message produces a counter tick and
    // nothing else: no category, no recommendedAction, no signal, so nothing
    // downstream can read it as an incident. The schema's own refinement
    // guarantees the two null fields, which is why `incident: false` and a
    // category cannot coexist even if a model tried.
    const proposal = feedbackAttentionClassificationProposalSchema.parse({
      results: [
        {
          messageId: "m-safe",
          incident: false,
          category: null,
          recommendedAction: null,
          hostileToUs: true,
          incidentDescribed: false,
          policyQuestion: null,
          confidence: 0.93,
        },
      ],
    });

    expect(
      validateFeedbackAttentionClassification(proposal, ["m-safe"]),
    ).toEqual({
      signals: [],
      hostileMessageIds: ["m-safe"],
      describedIncidentMessageIds: [],
      policyQuestions: [],
    });
  });

  it("keeps a disclosure's signal and its hostility on separate axes", () => {
    // One message that degrades an attendee *and* swears at us. Both are true and
    // the two lists are what let both be said; folding hostility into the
    // categories would have forced a choice between them, and the category is the
    // one an operator acts on.
    const proposal = feedbackAttentionClassificationProposalSchema.parse({
      results: [
        {
          messageId: "m-incident",
          incident: true,
          category: "abuse_of_a_participant",
          recommendedAction: "human_follow_up",
          hostileToUs: true,
          incidentDescribed: true,
          policyQuestion: null,
          confidence: 0.9,
        },
      ],
    });

    expect(
      validateFeedbackAttentionClassification(proposal, ["m-incident"]),
    ).toEqual({
      signals: [
        {
          category: "abuse_of_a_participant",
          recommendedAction: "human_follow_up",
          sourceMessageIds: ["m-incident"],
          confidence: 0.9,
        },
      ],
      hostileMessageIds: ["m-incident"],
      describedIncidentMessageIds: ["m-incident"],
      policyQuestions: [],
    });
  });

  it("separates announcing an incident from describing one", () => {
    // Νίτσα Κομποσερογιάννη's «αν θέλετε, μπορώ να σας πω τι έγινε». It stays an
    // incident — an operator has to see it even if she never writes again — and
    // it is the described list, not the signal, that decides whether the
    // application may say «Το προώθησα ήδη στην ομάδα μας».
    const proposal = feedbackAttentionClassificationProposalSchema.parse({
      results: [
        {
          messageId: "m-incident",
          incident: true,
          category: "other_safety",
          recommendedAction: "review",
          hostileToUs: false,
          incidentDescribed: false,
          policyQuestion: null,
          confidence: 0.6,
        },
      ],
    });

    expect(
      validateFeedbackAttentionClassification(proposal, ["m-incident"]),
    ).toEqual({
      signals: [
        {
          category: "other_safety",
          recommendedAction: "review",
          sourceMessageIds: ["m-incident"],
          confidence: 0.6,
        },
      ],
      hostileMessageIds: [],
      describedIncidentMessageIds: [],
      policyQuestions: [],
    });
  });

  it("refuses a description of an incident it just said was not one", () => {
    expect(() =>
      feedbackAttentionClassificationProposalSchema.parse({
        results: [
          {
            messageId: "m-safe",
            incident: false,
            category: null,
            recommendedAction: null,
            hostileToUs: false,
            incidentDescribed: true,
            policyQuestion: null,
            confidence: 0.9,
          },
        ],
      }),
    ).toThrow();
  });

  it("bounds historical context while keeping the target turn", () => {
    const longTranscript = Array.from({ length: 9 }, (_, index) => ({
      id: `m-${index + 1}`,
      seq: index + 1,
      actor: index === 8 ? ("participant" as const) : ("bot" as const),
      occurredAt: new Date(Date.UTC(2026, 6, 25, 18, index)).toISOString(),
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
          hostileToUs: false,
          incidentDescribed: false,
          policyQuestion: null,
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

  it("collects a policy question independently of every safety axis", () => {
    // Νίτσα Κομποσερογιάννη asked whether her tablemates would learn what she
    // had disclosed, in the same conversation that carried the disclosure. The
    // question must survive beside an incident, not instead of one.
    const proposal = feedbackAttentionClassificationProposalSchema.parse({
      results: [
        {
          messageId: "m-incident",
          incident: true,
          category: "other_safety",
          recommendedAction: "review",
          hostileToUs: false,
          incidentDescribed: true,
          policyQuestion: "will_they_find_out",
          confidence: 0.85,
        },
        {
          messageId: "m-safe",
          incident: false,
          category: null,
          recommendedAction: null,
          hostileToUs: false,
          incidentDescribed: false,
          policyQuestion: "how_long_kept",
          confidence: 0.9,
        },
      ],
    });

    expect(
      validateFeedbackAttentionClassification(proposal, [
        "m-incident",
        "m-safe",
      ]),
    ).toEqual({
      signals: [
        {
          category: "other_safety",
          recommendedAction: "review",
          sourceMessageIds: ["m-incident"],
          confidence: 0.85,
        },
      ],
      hostileMessageIds: [],
      describedIncidentMessageIds: ["m-incident"],
      policyQuestions: [
        { messageId: "m-incident", question: "will_they_find_out" },
        { messageId: "m-safe", question: "how_long_kept" },
      ],
    });
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
            // Supplied, so the rejection below is the contradiction between
            // `incident: false` and a category — not an incidentally missing key.
            hostileToUs: false,
            incidentDescribed: false,
            policyQuestion: null,
            confidence: 0.6,
          },
        ],
      }),
    ).toThrow();
  });
});
