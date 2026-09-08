import { describe, expect, it } from "vitest";
import {
  type FeedbackConversationDocument,
  type FeedbackConversationMessage,
  accumulateFeedbackExtractionUsage,
  buildFeedbackConversationGoals,
  deriveFeedbackConversationId,
  feedbackConversationDocumentSchema,
} from "./post-event-feedback-conversation.document.js";
import { POST_EVENT_FEEDBACK_QUESTION_SET_V1 } from "./question-set.js";

const campaignId = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const respondentParticipantId = "9f3c1a52-6e2b-4b4a-9a17-2cb2a6d13a55";
const createdAt = new Date("2026-07-25T10:00:00.000Z");
const updatedAt = new Date("2026-07-25T10:30:00.000Z");

describe("deriveFeedbackConversationId", () => {
  it("derives a stable RFC 4122 version 5 identifier", () => {
    expect(
      deriveFeedbackConversationId(campaignId, respondentParticipantId),
    ).toBe("85b4e284-28d9-55e5-9d8b-e981671d37d2");
    expect(
      deriveFeedbackConversationId(campaignId, respondentParticipantId),
    ).toBe(deriveFeedbackConversationId(campaignId, respondentParticipantId));
    expect(
      deriveFeedbackConversationId(
        campaignId,
        "5a1d2c3b-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
      ),
    ).toBe("378ac021-9f8e-556b-b77b-eeb3abd3df4c");

    // RFC 4122 DNS namespace vector, proving the digest and variant bits.
    expect(
      deriveFeedbackConversationId(
        "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
        "example.com",
      ),
    ).toBe("cfbff0d1-9375-5685-968c-48ce8b15ae17");
  });
});

describe("buildFeedbackConversationGoals", () => {
  it("preserves V1 goals and takes prompts from its campaign snapshot", () => {
    const goals = buildFeedbackConversationGoals(
      {
        ...POST_EVENT_FEEDBACK_QUESTION_SET_V1.copy,
        event_score: "Score?",
        liked: "Liked?",
        meet_again: "Again?",
        avoid: "Avoid?",
      },
      1,
    );

    expect(goals.map((goal) => goal.key)).toEqual([
      "event_score",
      "liked",
      "meet_again",
      "avoid",
    ]);
    expect(goals[0]?.prompt).toBe("Score?");
    expect(goals.at(-1)?.prompt).toBe("Avoid?");
  });
});

describe("feedbackConversationDocumentSchema", () => {
  it("reads a conversation written before attention reasons existed", () => {
    // Those documents are flagged with nothing to show, which is exactly what
    // they are. Failing to parse them would take the whole inbox down for a
    // field that only ever explains a flag.
    const { attentionReasons: _omitted, ...legacy } = feedbackConversation([]);

    expect(
      feedbackConversationDocumentSchema.parse(legacy).attentionReasons,
    ).toEqual([]);
  });

  it("authorizes a terminal outbox identity only on a message-bearing close", () => {
    const terminalOutboxId = "d4a4b3c2-8f1e-4d3c-9b2a-1e0f9d8c7b6a";
    expect(
      feedbackConversationDocumentSchema.parse({
        ...feedbackConversation([]),
        lifecycle: {
          state: "closed",
          reason: "completed",
          closedAt: updatedAt,
          terminalOutboxId,
        },
      }).lifecycle.terminalOutboxId,
    ).toBe(terminalOutboxId);

    expect(
      feedbackConversationDocumentSchema.parse({
        ...feedbackConversation([]),
        lifecycle: {
          state: "closed",
          reason: "stopped",
          closedAt: updatedAt,
          terminalOutboxId,
        },
      }).lifecycle.terminalOutboxId,
    ).toBe(terminalOutboxId);

    expect(() =>
      feedbackConversationDocumentSchema.parse({
        ...feedbackConversation([]),
        lifecycle: {
          state: "closed",
          reason: "cancelled",
          closedAt: updatedAt,
          terminalOutboxId,
        },
      }),
    ).toThrow(/completed, declined or stopped/);
  });

  it("defaults the token ledger on a conversation written before it existed", () => {
    const { extraction, ...rest } = feedbackConversation([]);
    const {
      usage: _usage,
      serviceTier: _serviceTier,
      ...beforeTheLedger
    } = extraction;

    const parsed = feedbackConversationDocumentSchema.parse({
      ...rest,
      extraction: beforeTheLedger,
    });

    // Every conversation on disk before 2026-07-31 lacks both fields, and a
    // document that will not parse is a conversation the inbox cannot show.
    expect(parsed.extraction.usage).toBeNull();
    expect(parsed.extraction.serviceTier).toBeNull();
  });

  it("reads legacy documents without reconciliation work and validates the bridge when present", () => {
    const legacy = feedbackConversation([]);
    expect(
      feedbackConversationDocumentSchema.parse(legacy).work,
    ).toBeUndefined();

    const nextActionAt = new Date("2026-07-25T11:00:00.000Z");
    expect(
      feedbackConversationDocumentSchema.parse({
        ...legacy,
        work: { revision: 3, nextActionAt, executionEpoch: 2 },
      }).work,
    ).toEqual({ revision: 3, nextActionAt, executionEpoch: 2 });

    expect(() =>
      feedbackConversationDocumentSchema.parse({
        ...legacy,
        work: { revision: 2, nextActionAt, executionEpoch: 3, leaseToken: "x" },
      }),
    ).toThrow();
  });
});

describe("accumulateFeedbackExtractionUsage", () => {
  const reported = (
    inputTokens: number | null,
    outputTokens: number | null,
    totalTokens: number | null,
  ) => ({ inputTokens, outputTokens, totalTokens });

  it("adds each component run over run", () => {
    const afterFirst = accumulateFeedbackExtractionUsage(
      null,
      reported(900, 120, 1_020),
    );

    expect(
      accumulateFeedbackExtractionUsage(afterFirst, reported(300, 80, 380)),
    ).toEqual(reported(1_200, 200, 1_400));
  });

  it("poisons only the component the provider left out, and permanently", () => {
    const afterFirst = accumulateFeedbackExtractionUsage(
      null,
      reported(900, 120, 1_020),
    );

    // The second run reported input but no output. The output total is now a
    // number missing a piece, which is not a smaller bill — it is a wrong one.
    const afterSilentRun = accumulateFeedbackExtractionUsage(
      afterFirst,
      reported(300, null, null),
    );
    expect(afterSilentRun).toEqual(reported(1_200, null, null));

    // A third, fully-reported run cannot recover tokens nobody counted. Input
    // keeps summing; the poisoned components stay null for the rest of the
    // conversation's life, which is what the cost script reads as unavailable.
    expect(
      accumulateFeedbackExtractionUsage(afterSilentRun, reported(100, 50, 150)),
    ).toEqual(reported(1_300, null, null));
  });

  it("carries a first report's own nulls into the total verbatim", () => {
    // The rehearsal stub reports nothing at all. The conversation's very first
    // run must not be recorded as a free one.
    expect(
      accumulateFeedbackExtractionUsage(null, reported(null, null, null)),
    ).toEqual(reported(null, null, null));
  });
});

function feedbackConversation(
  messages: FeedbackConversationMessage[],
): FeedbackConversationDocument {
  return {
    _id: deriveFeedbackConversationId(campaignId, respondentParticipantId),
    schemaVersion: 2,
    purpose: "post_event_feedback",
    channel: "whatsapp",
    campaignId,
    respondentParticipantId,
    phoneAtLaunch: "+306900000000",
    lifecycle: { state: "open", reason: null, closedAt: null },
    control: { mode: "bot", source: "launch", changedAt: createdAt },
    goals: buildFeedbackConversationGoals(),
    messages,
    extraction: {
      cursorSeq: 0,
      lastRunAt: null,
      model: null,
      usage: null,
      serviceTier: null,
      parkedSince: null,
      parkedRuns: 0,
      parkedNoticeSentAt: null,
    },
    needsAttention: false,
    attentionReasons: [],
    remindedAt: null,
    reminderCount: 0,
    awaitingHuman: false,
    hostileTurns: 0,
    extractionFallbackAckSent: false,
    staffClose: null,
    createdAt,
    updatedAt,
  };
}
