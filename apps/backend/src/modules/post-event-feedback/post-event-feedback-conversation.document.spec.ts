import { randomUUID } from "node:crypto";

import { BSON } from "mongodb";
import { describe, expect, it } from "vitest";

import { FEEDBACK_ANSWER_QUESTION_KEYS } from "@join-the-six/database";
import { conversationThreadDocumentSchema } from "../conversations/conversation-thread.schemas.js";
import {
  FEEDBACK_CONVERSATION_MAX_MESSAGES,
  FEEDBACK_CONVERSATION_MESSAGE_MAX_TEXT_LENGTH,
  type FeedbackConversationDocument,
  type FeedbackConversationMessage,
  buildFeedbackConversationGoals,
  deriveFeedbackConversationId,
  feedbackConversationDocumentSchema,
} from "./post-event-feedback-conversation.document.js";

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

  it("requires a campaign UUID namespace and a respondent name", () => {
    expect(() =>
      deriveFeedbackConversationId("campaign-1", respondentParticipantId),
    ).toThrow();
    expect(() => deriveFeedbackConversationId(campaignId, " ")).toThrow();
  });
});

describe("buildFeedbackConversationGoals", () => {
  it("uses the versioned question-set keys in their locked order", () => {
    const goals = buildFeedbackConversationGoals();

    expect(goals.map((goal) => goal.key)).toEqual([
      ...FEEDBACK_ANSWER_QUESTION_KEYS,
    ]);
    expect(goals.map((goal) => goal.ordinal)).toEqual([1, 2, 3, 4]);
    expect(goals.every((goal) => goal.status === "pending")).toBe(true);
  });

  it("takes prompts from the campaign copy snapshot", () => {
    const goals = buildFeedbackConversationGoals({
      intro: "intro",
      event_score: "Score?",
      liked: "Liked?",
      meet_again: "Again?",
      avoid: "Avoid?",
      closing: "closing",
      stop_ack: "stop",
      reminder: "reminder",
      reminder_followup: "followup {question}",
      cannot_read_media: "cannot read",
    });

    expect(goals[0]?.prompt).toBe("Score?");
    expect(goals.at(-1)?.prompt).toBe("Avoid?");
  });
});

describe("feedbackConversationDocumentSchema", () => {
  it("accepts a launched conversation with an actor-labelled transcript", () => {
    const document = feedbackConversation([
      participantMessage(1),
      botMessage(2),
    ]);

    expect(feedbackConversationDocumentSchema.parse(document)).toEqual(
      document,
    );
  });

  it("reads a conversation written before attention reasons existed", () => {
    // Those documents are flagged with nothing to show, which is exactly what
    // they are. Failing to parse them would take the whole inbox down for a
    // field that only ever explains a flag.
    const { attentionReasons: _omitted, ...legacy } = feedbackConversation([]);

    expect(
      feedbackConversationDocumentSchema.parse(legacy).attentionReasons,
    ).toEqual([]);
  });

  it("refuses an attention reason resolved by nobody", () => {
    // `resolvedAt` is what stops it counting toward `needsAttention`, so a
    // half-written resolution silently dismisses a disclosure and leaves no
    // record of who did it.
    expect(() =>
      feedbackConversationDocumentSchema.parse({
        ...feedbackConversation([]),
        attentionReasons: [
          {
            id: "22222222-2222-4222-8222-222222222222",
            kind: "safety",
            messageId: "11111111-1111-4111-8111-111111111111",
            at: new Date("2026-07-27T10:00:00.000Z"),
            resolvedAt: new Date("2026-07-27T11:00:00.000Z"),
            resolvedBy: null,
          },
        ],
      }),
    ).toThrow();
  });

  it("stays disjoint from the schema-v1 assistant aggregate", () => {
    expect(() =>
      conversationThreadDocumentSchema.parse(feedbackConversation([])),
    ).toThrow();
    expect(() =>
      feedbackConversationDocumentSchema.parse({
        ...feedbackConversation([]),
        schemaVersion: 1,
      }),
    ).toThrow();
  });

  it("rejects a lifecycle that contradicts its terminal reason", () => {
    expect(() =>
      feedbackConversationDocumentSchema.parse({
        ...feedbackConversation([]),
        lifecycle: { state: "open", reason: "stopped", closedAt: createdAt },
      }),
    ).toThrow(/terminal reason/);

    expect(() =>
      feedbackConversationDocumentSchema.parse({
        ...feedbackConversation([]),
        lifecycle: { state: "closed", reason: null, closedAt: null },
      }),
    ).toThrow(/requires a reason/);
  });

  it("rejects human control without a control source", () => {
    expect(() =>
      feedbackConversationDocumentSchema.parse({
        ...feedbackConversation([]),
        control: { mode: "human", source: "launch", changedAt: createdAt },
      }),
    ).toThrow(/staff action or external outbound/);
  });

  it("requires message provenance that matches the actor", () => {
    expect(() =>
      feedbackConversationDocumentSchema.parse(
        feedbackConversation([{ ...participantMessage(1), ingressId: null }]),
      ),
    ).toThrow(/durable ingress id/);

    expect(() =>
      feedbackConversationDocumentSchema.parse(
        feedbackConversation([{ ...botMessage(1), seq: 1, outboxId: null }]),
      ),
    ).toThrow(/outbox id/);
  });

  it("requires contiguous sequence numbers and unique provenance", () => {
    // A gap: one message claiming seq 2 leaves nothing at seq 1, and the
    // extraction cursor walks sequence numbers.
    expect(() =>
      feedbackConversationDocumentSchema.parse(
        feedbackConversation([{ ...participantMessage(1), seq: 2 }]),
      ),
    ).toThrow(/contiguous sequence numbers/);

    // Two messages cannot share one sequence number.
    expect(() =>
      feedbackConversationDocumentSchema.parse(
        feedbackConversation([
          participantMessage(1),
          { ...participantMessage(2), seq: 1 },
        ]),
      ),
    ).toThrow(/contiguous sequence numbers/);

    const ingressId = randomUUID();
    expect(() =>
      feedbackConversationDocumentSchema.parse(
        feedbackConversation([
          { ...participantMessage(1), ingressId },
          { ...participantMessage(2), ingressId },
        ]),
      ),
    ).toThrow(/unique provenance/);
  });

  it("keeps the extraction cursor inside the transcript", () => {
    expect(() =>
      feedbackConversationDocumentSchema.parse({
        ...feedbackConversation([participantMessage(1)]),
        extraction: { cursorSeq: 2, lastRunAt: updatedAt, model: null },
      }),
    ).toThrow(/cursor cannot pass/);
  });

  it("caps the transcript and stays far below the 16 MiB BSON limit", () => {
    const messages = Array.from(
      { length: FEEDBACK_CONVERSATION_MAX_MESSAGES },
      (_, index) => participantMessage(index + 1),
    );

    expect(
      feedbackConversationDocumentSchema.parse(feedbackConversation(messages))
        .messages,
    ).toHaveLength(FEEDBACK_CONVERSATION_MAX_MESSAGES);
    expect(() =>
      feedbackConversationDocumentSchema.parse(
        feedbackConversation([
          ...messages,
          participantMessage(FEEDBACK_CONVERSATION_MAX_MESSAGES + 1),
        ]),
      ),
    ).toThrow();

    // U+0800 occupies three UTF-8 bytes per JavaScript string code unit.
    const worstCase = feedbackConversationDocumentSchema.parse(
      feedbackConversation(
        messages.map((message) => ({
          ...message,
          text: "ࠀ".repeat(FEEDBACK_CONVERSATION_MESSAGE_MAX_TEXT_LENGTH),
        })),
      ),
    );

    expect(BSON.calculateObjectSize(worstCase)).toBeLessThan(
      16 * 1_024 * 1_024,
    );
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

function participantMessage(seq: number): FeedbackConversationMessage {
  return {
    id: randomUUID(),
    seq,
    actor: "participant",
    text: "Πέρασα τέλεια!",
    providerMessageId: null,
    ingressId: randomUUID(),
    outboxId: null,
    attention: null,
    at: createdAt,
  };
}

function botMessage(seq: number): FeedbackConversationMessage {
  return {
    id: randomUUID(),
    seq,
    actor: "bot",
    text: "Πώς σου φάνηκε η βραδιά;",
    providerMessageId: null,
    ingressId: null,
    outboxId: randomUUID(),
    attention: null,
    at: createdAt,
  };
}
