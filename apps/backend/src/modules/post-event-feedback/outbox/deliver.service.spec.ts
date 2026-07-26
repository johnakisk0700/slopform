import { describe, expect, it, vi } from "vitest";

import type { MessageOutboxRow } from "@join-the-six/database";

import type { DatabaseService } from "../../../infrastructure/database/database.service.js";
import {
  FeedbackConversationCapacityError,
  type FeedbackConversationRepository,
} from "../post-event-feedback-conversation.repository.js";
import { FeedbackOutboundTranscriptService } from "./outbound-transcript.service.js";
import type { FeedbackTransport } from "./transport.js";
import { MessageOutboxDeliveryService } from "./deliver.service.js";
import type { FeedbackCampaignRepository } from "../campaign/campaign.repository.js";
import type { FeedbackOutboxRepository } from "./outbox.repository.js";

const outboxId = "66de52a8-1a26-4cbb-b8d1-fcf8bdc2dd51";
const conversationId = "7c57f3b8-2b13-48f5-8730-18ac71f490cd";

function sendingRow(
  overrides: Partial<MessageOutboxRow> = {},
): MessageOutboxRow {
  return {
    id: outboxId,
    conversationId,
    campaignId: "89eccaa5-9ce6-4dcf-a630-5e35e4ec6f0d",
    kind: "reply",
    body: "Ευχαριστούμε!",
    status: "sending",
    dedupeKey: "conversation:1:cursor:3",
    createdByStaff: null,
    providerLogId: null,
    providerMessageId: null,
    deliveryStatus: null,
    sentAt: null,
    deliveredAt: null,
    readAt: null,
    playedAt: null,
    deliveryUpdatedAt: null,
    createdAt: new Date("2026-07-25T00:00:00.000Z"),
    updatedAt: new Date("2026-07-25T00:00:00.000Z"),
    ...overrides,
  };
}

describe("MessageOutboxDeliveryService", () => {
  it("sends through the transport and marks the outbox sent", async () => {
    const { service, repository, transport } = createService();
    repository.findOutboxById.mockResolvedValue(sendingRow());
    transport.sendText.mockResolvedValue({
      outcome: "accepted",
      providerLogId: "42",
      providerMessageId: "wamid.1",
      providerStatus: "sent",
    });

    await expect(service.deliver(outboxId, "correlation-1")).resolves.toEqual({
      outcome: "sent",
    });
    expect(transport.sendText).toHaveBeenCalledWith({
      to: "+306900000001",
      text: "Ευχαριστούμε!",
      outboxId,
    });
    expect(repository.updateOutboxDelivery).toHaveBeenCalledWith(
      expect.anything(),
      outboxId,
      expect.objectContaining({
        status: "sent",
        deliveryStatus: "sent",
        providerLogId: "42",
        providerMessageId: "wamid.1",
      }),
    );
  });

  it("repairs a missing transcript entry before sending", async () => {
    const { service, repository, transport, conversations } = createService();
    repository.findOutboxById.mockResolvedValue(sendingRow());
    transport.sendText.mockResolvedValue({
      outcome: "accepted",
      providerLogId: "42",
      providerMessageId: "wamid.1",
      providerStatus: "sent",
    });

    await service.deliver(outboxId, "correlation-1");

    // The forward repair for a producer that crashed between its PostgreSQL
    // commit and the append — normally an idempotent no-op.
    expect(conversations.appendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: "bot",
        outboxId,
        text: "Ευχαριστούμε!",
      }),
    );
    expect(
      conversations.appendMessage.mock.invocationCallOrder[0],
    ).toBeLessThan(transport.sendText.mock.invocationCallOrder[0] as number);
  });

  it("cancels instead of sending a message the transcript cannot record", async () => {
    const { service, repository, transport, conversations } = createService();
    repository.findOutboxById.mockResolvedValue(sendingRow());
    conversations.appendMessage.mockRejectedValue(
      new FeedbackConversationCapacityError(),
    );

    await expect(service.deliver(outboxId, "correlation-1")).resolves.toEqual({
      outcome: "cancelled",
    });
    expect(transport.sendText).not.toHaveBeenCalled();
    expect(repository.updateOutboxStatus).toHaveBeenCalledWith(
      expect.anything(),
      outboxId,
      "cancelled",
    );
  });

  it("never retries an unknown send outcome", async () => {
    const { service, repository, transport } = createService();
    repository.findOutboxById.mockResolvedValue(sendingRow());
    transport.sendText.mockResolvedValue({
      outcome: "unknown",
      reason: "timeout",
    });

    await expect(service.deliver(outboxId, "correlation-1")).resolves.toEqual({
      outcome: "awaiting_observation",
    });
    expect(transport.sendText).toHaveBeenCalledTimes(1);
    expect(repository.updateOutboxDelivery).toHaveBeenCalledWith(
      expect.anything(),
      outboxId,
      expect.objectContaining({
        status: "sending",
        deliveryStatus: "pending",
      }),
    );

    repository.findOutboxById.mockResolvedValue(
      sendingRow({ deliveryStatus: "pending" }),
    );
    await expect(service.deliver(outboxId, "correlation-1")).resolves.toEqual({
      outcome: "awaiting_observation",
    });
    expect(transport.sendText).toHaveBeenCalledTimes(1);
  });

  it("releases the lease when the campaign kill switch is active", async () => {
    const { service, repository, transport } = createService();
    repository.findOutboxById.mockResolvedValue(sendingRow());
    repository.findCampaignById.mockResolvedValue({ status: "paused" });

    await expect(service.deliver(outboxId, "correlation-1")).resolves.toEqual({
      outcome: "held",
    });
    expect(transport.sendText).not.toHaveBeenCalled();
    expect(repository.releaseOutboxLease).toHaveBeenCalledWith(
      outboxId,
      expect.any(Date),
    );
  });

  it("reconciles via provider log id instead of sending again", async () => {
    const { service, repository, transport } = createService();
    repository.findOutboxById.mockResolvedValue(
      sendingRow({ providerLogId: "42", deliveryStatus: "pending" }),
    );
    transport.getMessageInfo.mockResolvedValue({
      providerLogId: "42",
      providerMessageId: "wamid.1",
      status: "delivered",
      occurredAt: new Date("2026-07-25T00:01:00.000Z"),
    });

    await expect(service.deliver(outboxId, "correlation-1")).resolves.toEqual({
      outcome: "reconciled",
    });
    expect(transport.sendText).not.toHaveBeenCalled();
    expect(repository.updateOutboxDelivery).toHaveBeenCalledWith(
      expect.anything(),
      outboxId,
      expect.objectContaining({
        status: "sent",
        deliveryStatus: "delivered",
        providerMessageId: "wamid.1",
      }),
    );
  });

  it("skips cancelled and held rows without sending", async () => {
    const { service, repository, transport } = createService();
    repository.findOutboxById.mockResolvedValue(
      sendingRow({ status: "cancelled" }),
    );

    await expect(service.deliver(outboxId, "c")).resolves.toEqual({
      outcome: "cancelled",
    });
    expect(transport.sendText).not.toHaveBeenCalled();

    repository.findOutboxById.mockResolvedValue(sendingRow({ status: "held" }));
    await expect(service.deliver(outboxId, "c")).resolves.toEqual({
      outcome: "held",
    });
    expect(transport.sendText).not.toHaveBeenCalled();
  });

  it("marks a rejected send as failed", async () => {
    const { service, repository, transport } = createService();
    repository.findOutboxById.mockResolvedValue(sendingRow());
    transport.sendText.mockResolvedValue({
      outcome: "not-accepted",
      reason: "http",
    });

    await expect(service.deliver(outboxId, "c")).resolves.toEqual({
      outcome: "failed",
    });
    expect(repository.updateOutboxStatus).toHaveBeenCalledWith(
      expect.anything(),
      outboxId,
      "failed",
    );
  });
});

function createService(): {
  service: MessageOutboxDeliveryService;
  repository: {
    findOutboxById: ReturnType<typeof vi.fn>;
    findCampaignById: ReturnType<typeof vi.fn>;
    updateOutboxDelivery: ReturnType<typeof vi.fn>;
    updateOutboxStatus: ReturnType<typeof vi.fn>;
    releaseOutboxLease: ReturnType<typeof vi.fn>;
  };
  transport: {
    sendText: ReturnType<typeof vi.fn>;
    getMessageInfo: ReturnType<typeof vi.fn>;
  };
  conversations: {
    findById: ReturnType<typeof vi.fn>;
    appendMessage: ReturnType<typeof vi.fn>;
    setNeedsAttention: ReturnType<typeof vi.fn>;
  };
} {
  const repository = {
    findOutboxById: vi.fn(),
    findCampaignById: vi.fn().mockResolvedValue({ status: "launched" }),
    updateOutboxDelivery: vi.fn().mockResolvedValue(undefined),
    updateOutboxStatus: vi.fn().mockResolvedValue(undefined),
    releaseOutboxLease: vi.fn().mockResolvedValue(undefined),
  };
  const transport = {
    sendText: vi.fn(),
    getMessageInfo: vi.fn(),
  };
  const database = {
    transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) =>
      work({}),
    ),
  };
  const conversation = {
    _id: conversationId,
    phoneAtLaunch: "+306900000001",
  };
  const conversations = {
    findById: vi.fn().mockResolvedValue(conversation),
    appendMessage: vi
      .fn()
      .mockResolvedValue({ appended: true, message: {}, conversation }),
    setNeedsAttention: vi.fn().mockResolvedValue({ changed: true }),
  };

  return {
    service: new MessageOutboxDeliveryService(
      database as unknown as DatabaseService,
      repository as unknown as FeedbackCampaignRepository,
      repository as unknown as FeedbackOutboxRepository,
      conversations as unknown as FeedbackConversationRepository,
      new FeedbackOutboundTranscriptService(
        database as unknown as DatabaseService,
        repository as unknown as FeedbackOutboxRepository,
        conversations as unknown as FeedbackConversationRepository,
      ),
      transport as unknown as FeedbackTransport,
    ),
    repository,
    transport,
    conversations,
  };
}
