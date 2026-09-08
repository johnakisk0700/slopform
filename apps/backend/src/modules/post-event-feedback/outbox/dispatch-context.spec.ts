import { describe, expect, it } from "vitest";

import {
  createFeedbackClosingDedupeKey,
  createFeedbackHandoffDedupeKey,
  createFeedbackHostilityStopDedupeKey,
  createFeedbackReplyDedupeKey,
} from "../extraction/extraction.schemas.js";
import {
  buildFeedbackConversationGoals,
  deriveFeedbackConversationId,
  feedbackConversationDocumentSchema,
  type FeedbackConversationDocument,
} from "../post-event-feedback-conversation.document.js";
import {
  DISPATCH_CONTEXT_INVALID,
  DISPATCH_CONTEXT_MISMATCH,
  DISPATCH_CONTEXT_UNUSABLE,
  FALLBACK_FENCE_NOT_SENDABLE,
  evaluateDispatchContext,
  ordinaryDispatchEvidenceFromConversation,
  parseDispatchContext,
} from "./dispatch-context.js";

const conversationId = "7c57f3b8-2b13-48f5-8730-18ac71f490cd";
const campaignId = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const respondentParticipantId = "9f3c1a52-6e2b-4b4a-9a17-2cb2a6d13a55";
const createdAt = new Date("2026-07-25T10:00:00.000Z");
const ingressId = "e2d32755-d43f-42eb-a209-d731d1dd47d7";

describe("dispatch context", () => {
  it("copies ordinary evidence from the supplied document without refreshing it", () => {
    const original = conversationDocument({
      control: {
        mode: "bot",
        source: "launch",
        changedAt: createdAt,
      },
      work: {
        revision: 7,
        nextActionAt: null,
        executionEpoch: 3,
        campaignResumeGeneration: 4,
      },
      messages: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          seq: 1,
          actor: "participant",
          text: "ok",
          at: createdAt,
          ingressId,
          providerMessageId: null,
          outboxId: null,
          attention: null,
        },
      ],
    });

    const evidence = ordinaryDispatchEvidenceFromConversation(original);

    expect(evidence).toEqual({
      latestMessageSeq: 1,
      control: {
        mode: "bot",
        source: "launch",
        changedAt: createdAt.toISOString(),
      },
      work: {
        revision: 7,
        executionEpoch: 3,
        campaignResumeGeneration: 4,
      },
      participantIngressIds: [ingressId],
    });
  });

  it("never treats missing or unusable context as permission", () => {
    expect(parseDispatchContext(undefined).state).toBe("reject");
    expect(parseDispatchContext(null)).toMatchObject({
      reason: DISPATCH_CONTEXT_INVALID,
    });
    expect(
      parseDispatchContext({ schemaVersion: 1, purpose: "unusable_legacy" }),
    ).toMatchObject({ reason: DISPATCH_CONTEXT_UNUSABLE });
    expect(
      parseDispatchContext({ schemaVersion: 1, purpose: "non_ordinary" }),
    ).toMatchObject({ reason: DISPATCH_CONTEXT_INVALID });
  });

  it("rejects purpose/kind/dedupe mismatches and never-sendable fences", () => {
    const ordinary = {
      schemaVersion: 1 as const,
      purpose: "extraction_reply" as const,
      evidence: ordinaryDispatchEvidenceFromConversation(
        conversationDocument(),
      ),
    };
    expect(
      evaluateDispatchContext({
        context: ordinary,
        kind: "staff",
        dedupeKey: createFeedbackReplyDedupeKey(conversationId, 1),
        conversationId,
      }),
    ).toMatchObject({ reason: DISPATCH_CONTEXT_MISMATCH });
    expect(
      evaluateDispatchContext({
        context: ordinary,
        kind: "reply",
        dedupeKey: createFeedbackClosingDedupeKey(conversationId, 1),
        conversationId,
      }),
    ).toMatchObject({ reason: DISPATCH_CONTEXT_MISMATCH });
    expect(
      evaluateDispatchContext({
        context: { schemaVersion: 1, purpose: "extraction_fallback_fence" },
        kind: "system",
        dedupeKey: `feedback-fallback-${conversationId}-1`,
        conversationId,
      }),
    ).toMatchObject({ reason: FALLBACK_FENCE_NOT_SENDABLE });
    expect(
      evaluateDispatchContext({
        context: ordinary,
        kind: "reply",
        dedupeKey: createFeedbackHandoffDedupeKey(conversationId, 1),
        conversationId,
      }).state,
    ).toBe("usable");
    expect(
      evaluateDispatchContext({
        context: ordinary,
        kind: "reply",
        dedupeKey: createFeedbackHostilityStopDedupeKey(conversationId),
        conversationId,
      }).state,
    ).toBe("usable");
  });
});

function conversationDocument(
  overrides: Partial<FeedbackConversationDocument> = {},
): FeedbackConversationDocument {
  return feedbackConversationDocumentSchema.parse({
    _id: deriveFeedbackConversationId(campaignId, respondentParticipantId),
    schemaVersion: 2,
    purpose: "post_event_feedback",
    channel: "whatsapp",
    campaignId,
    respondentParticipantId,
    phoneAtLaunch: "+306900000000",
    lifecycle: { state: "open", reason: null, closedAt: null },
    control: { mode: "bot", source: "launch", changedAt: createdAt },
    work: {
      revision: 0,
      nextActionAt: null,
      executionEpoch: 0,
    },
    goals: buildFeedbackConversationGoals(),
    messages: [],
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
    updatedAt: createdAt,
    ...overrides,
  });
}
