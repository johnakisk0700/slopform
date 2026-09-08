import { randomUUID } from "node:crypto";

import { BSON } from "mongodb";
import { describe, expect, it } from "vitest";

import {
  CONVERSATION_MESSAGE_MAX_CONTENT_LENGTH,
  CONVERSATION_THREAD_MAX_TURNS,
  conversationThreadDocumentSchema,
  type ConversationThreadDocument,
  type ConversationTurn,
} from "./conversation-thread.schemas.js";

const createdAt = new Date("2026-07-25T10:00:00.000Z");

describe("conversationThreadDocumentSchema", () => {
  it("caps the embedded aggregate below MongoDB's BSON document ceiling", () => {
    const maximum = Array.from(
      { length: CONVERSATION_THREAD_MAX_TURNS },
      (_, index) => queuedTurn(index + 1),
    );
    expect(
      conversationThreadDocumentSchema.parse(adminConversation(maximum)).turns,
    ).toHaveLength(CONVERSATION_THREAD_MAX_TURNS);

    expect(() =>
      conversationThreadDocumentSchema.parse(
        adminConversation([
          ...maximum,
          queuedTurn(CONVERSATION_THREAD_MAX_TURNS + 1),
        ]),
      ),
    ).toThrow();
  });

  it("allows only the inherited prefix of an immutable branch to predate it", () => {
    const inherited = {
      ...queuedTurn(1),
      createdAt: new Date("2026-07-23T09:00:00.000Z"),
    };
    const replacement = queuedTurn(2);
    const branch = {
      ...adminConversation([inherited, replacement]),
      branchedFrom: {
        threadId: "487cf55a-2c13-4af3-b535-660c2793107c",
        turnId: "cbef5725-76e3-4113-98c1-b9eacde554a3",
        sequence: 2,
      },
    };

    expect(conversationThreadDocumentSchema.parse(branch).turns).toHaveLength(
      2,
    );
    expect(() =>
      conversationThreadDocumentSchema.parse({
        ...branch,
        turns: [inherited],
      }),
    ).toThrow(/replacement turn/);
    expect(() =>
      conversationThreadDocumentSchema.parse({
        ...adminConversation([inherited]),
        branchedFrom: null,
      }),
    ).toThrow(/thread-bounded timestamps/);
  });

  it("keeps a worst-case valid aggregate below MongoDB's 16 MiB limit", () => {
    // U+0800 occupies three UTF-8 bytes per JavaScript string code unit.
    const maximumContent = "\u0800".repeat(
      CONVERSATION_MESSAGE_MAX_CONTENT_LENGTH,
    );
    const turns = Array.from(
      { length: CONVERSATION_THREAD_MAX_TURNS },
      (_, index): ConversationTurn => ({
        ...queuedTurn(index + 1),
        status: "succeeded",
        input: { actor: "participant", content: maximumContent },
        output: { actor: "assistant", content: maximumContent },
        startedAt: createdAt,
        completedAt: createdAt,
      }),
    );
    const document: ConversationThreadDocument = {
      ...adminConversation(turns),
      purpose: "post_event_feedback",
      channel: "whatsapp",
      owner: { type: "participant", id: "x".repeat(200) },
      title: "\u0800".repeat(160),
      goals: Array.from({ length: 10 }, (_, index) => ({
        key: `feedback.${index + 1}`,
        ordinal: index + 1,
        prompt: "\u0800".repeat(500),
        status: "answered" as const,
        answer: "\u0800".repeat(4_000),
        updatedAt: createdAt,
      })),
    };
    const parsed = conversationThreadDocumentSchema.parse(document);

    expect(BSON.calculateObjectSize(parsed)).toBeLessThan(16 * 1_024 * 1_024);
  });
});

function adminConversation(
  turns: ConversationTurn[],
): ConversationThreadDocument {
  return {
    _id: "66de52a8-1a26-4cbb-b8d1-fcf8bdc2dd51",
    schemaVersion: 1,
    purpose: "admin_assistant",
    channel: "admin",
    owner: { type: "staff", id: "user_owner" },
    title: "Conversation",
    state: "active",
    goals: [],
    humanTakeover: {
      status: "inactive",
      requestedAt: null,
      resolvedAt: null,
    },
    branchedFrom: null,
    turns,
    createdAt,
    updatedAt: createdAt,
  };
}

function queuedTurn(sequence: number): ConversationTurn {
  return {
    id: randomUUID(),
    requestId: randomUUID(),
    sequence,
    status: "queued",
    attempt: 1,
    model: "google/gemini-3.6-flash",
    reasoningEffort: "low",
    serviceTier: "standard",
    reasoning: null,
    input: { actor: "admin", content: `Question ${sequence}` },
    output: null,
    partial: null,
    error: null,
    createdAt,
    startedAt: null,
    completedAt: null,
  };
}
