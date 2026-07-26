import { Logger } from "@nestjs/common";
import type { AppTransaction, MessageOutboxRow } from "@join-the-six/database";
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { DatabaseService } from "../../infrastructure/database/database.service.js";
import {
  FeedbackConversationCapacityError,
  type FeedbackConversationRepository,
} from "./post-event-feedback-conversation.repository.js";
import { FEEDBACK_CONVERSATION_MESSAGE_MAX_TEXT_LENGTH } from "./post-event-feedback-conversation.document.js";
import {
  FEEDBACK_OUTBOX_KIND_ACTORS,
  FeedbackOutboundTranscriptService,
  UnsupportedMessageOutboxKindError,
} from "./outbox/outbound-transcript.service.js";
import type { FeedbackOutboxRepository } from "./outbox/outbox.repository.js";

const conversationId = "6f0f2f8a-2b73-5a02-9d0a-3f0b8f5b1c21";
const outboxId = "d3e9a2c6-4e87-4c4b-9c40-4f2c5a4e3d99";
const at = new Date("2026-07-25T10:00:00.000Z");

describe("FeedbackOutboundTranscriptService", () => {
  beforeAll(() => {
    Logger.overrideLogger(false);
  });

  it("labels every outbox kind with the actor the transcript schema allows", () => {
    // `actor: system` is reserved for entries with no transport provenance, so
    // an outbox-backed message can only ever be `bot` or `staff`.
    expect(FEEDBACK_OUTBOX_KIND_ACTORS).toEqual({
      intro: "bot",
      reminder: "bot",
      reply: "bot",
      system: "bot",
      staff: "staff",
    });
  });

  it.each([
    ["intro", "bot"],
    ["reminder", "bot"],
    ["reply", "bot"],
    ["system", "bot"],
    ["staff", "staff"],
  ])(
    "appends a %s row as actor %s with outbox provenance",
    async (kind, actor) => {
      const { service, conversations } = createService();

      await expect(service.record(outboxRow({ kind }), at)).resolves.toEqual({
        outcome: "appended",
        conversation: expect.anything(),
      });
      expect(conversations.appendMessage).toHaveBeenCalledWith({
        conversationId,
        actor,
        text: "Γεια σου!",
        at,
        outboxId,
      });
    },
  );

  it("is idempotent by outboxId so a replayed producer adds nothing", async () => {
    const { service, conversations } = createService();
    conversations.appendMessage.mockResolvedValue({
      appended: false,
      message: {},
      conversation: {},
    });

    await expect(service.record(outboxRow(), at)).resolves.toMatchObject({
      outcome: "already_present",
    });
  });

  it("uses the stored row body, never a caller-proposed text", async () => {
    const { service, conversations } = createService();

    await service.record(outboxRow({ body: "  Ευχαριστούμε!  " }), at);

    expect(conversations.appendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Ευχαριστούμε!" }),
    );
  });

  it("cancels the row instead of sending a message it cannot record", async () => {
    const { service, conversations, repository } = createService();
    conversations.appendMessage.mockRejectedValue(
      new FeedbackConversationCapacityError(),
    );

    await expect(service.record(outboxRow(), at, "corr-1")).resolves.toEqual({
      outcome: "cancelled",
      reason: "transcript_capacity",
    });
    expect(repository.updateOutboxStatus).toHaveBeenCalledWith(
      expect.anything(),
      outboxId,
      "cancelled",
    );
    // The repository already raised the flag on this path; raising it twice
    // would be a redundant write.
    expect(conversations.setNeedsAttention).not.toHaveBeenCalled();
  });

  it("cancels and flags a body the transcript cannot hold, without retrying forever", async () => {
    const { service, conversations, repository } = createService();
    const body = "α".repeat(FEEDBACK_CONVERSATION_MESSAGE_MAX_TEXT_LENGTH + 1);

    await expect(service.record(outboxRow({ body }), at)).resolves.toEqual({
      outcome: "cancelled",
      reason: "body_too_long",
    });
    expect(conversations.appendMessage).not.toHaveBeenCalled();
    expect(repository.updateOutboxStatus).toHaveBeenCalledWith(
      expect.anything(),
      outboxId,
      "cancelled",
    );
    expect(conversations.setNeedsAttention).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId, needsAttention: true }),
    );
  });

  it("refuses to mislabel an outbox kind the actor map does not know", async () => {
    const { service } = createService();

    await expect(
      service.record(outboxRow({ kind: "broadcast" }), at),
    ).rejects.toBeInstanceOf(UnsupportedMessageOutboxKindError);
  });

  it("propagates a non-capacity persistence failure instead of cancelling", async () => {
    const { service, conversations, repository } = createService();
    conversations.appendMessage.mockRejectedValue(new Error("mongo down"));

    await expect(service.record(outboxRow(), at)).rejects.toThrow("mongo down");
    expect(repository.updateOutboxStatus).not.toHaveBeenCalled();
  });
});

function outboxRow(
  overrides: Partial<MessageOutboxRow> = {},
): Pick<MessageOutboxRow, "id" | "conversationId" | "kind" | "body"> {
  return {
    id: outboxId,
    conversationId,
    kind: "intro",
    body: "Γεια σου!",
    ...overrides,
  };
}

function createService(): {
  service: FeedbackOutboundTranscriptService;
  conversations: {
    appendMessage: ReturnType<typeof vi.fn>;
    setNeedsAttention: ReturnType<typeof vi.fn>;
  };
  repository: { updateOutboxStatus: ReturnType<typeof vi.fn> };
} {
  const conversations = {
    appendMessage: vi
      .fn()
      .mockResolvedValue({ appended: true, message: {}, conversation: {} }),
    setNeedsAttention: vi.fn().mockResolvedValue({ changed: true }),
  };
  const repository = {
    updateOutboxStatus: vi.fn().mockResolvedValue(undefined),
  };
  const database = {
    transaction: vi.fn(async (work: (tx: AppTransaction) => Promise<unknown>) =>
      work({} as AppTransaction),
    ),
  };

  return {
    service: new FeedbackOutboundTranscriptService(
      database as unknown as DatabaseService,
      repository as unknown as FeedbackOutboxRepository,
      conversations as unknown as FeedbackConversationRepository,
    ),
    conversations,
    repository,
  };
}
