import { describe, expect, it, vi } from "vitest";

import type { DatabaseService } from "../../../infrastructure/database/database.service.js";
import { MessageOutboxDeliveryStatusService } from "./delivery-status.service.js";
import type { FeedbackOutboxRepository } from "./outbox.repository.js";

const outboxId = "66de52a8-1a26-4cbb-b8d1-fcf8bdc2dd51";

describe("MessageOutboxDeliveryStatusService", () => {
  it("upgrades delivery columns on a correlated outbox row", async () => {
    const repository = {
      findOutboxByProviderMessageId: vi.fn().mockResolvedValue({
        id: outboxId,
        conversationId: "7c57f3b8-2b13-48f5-8730-18ac71f490cd",
        status: "sent",
        deliveryStatus: "sent",
        sentAt: new Date("2026-07-25T00:00:00.000Z"),
        deliveredAt: null,
        readAt: null,
        playedAt: null,
      }),
      lockConversation: vi.fn().mockResolvedValue(undefined),
      updateOutboxDelivery: vi.fn().mockResolvedValue(undefined),
    };
    const database = {
      transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) =>
        work({}),
      ),
    };
    const service = new MessageOutboxDeliveryStatusService(
      database as unknown as DatabaseService,
      repository as unknown as FeedbackOutboxRepository,
    );

    await expect(
      service.applyStatusChange(
        {
          providerMessageId: "wamid.1",
          status: "delivered",
          occurredAt: new Date("2026-07-25T00:01:00.000Z"),
        },
        "correlation-1",
      ),
    ).resolves.toEqual({ outcome: "updated", outboxId });

    expect(repository.updateOutboxDelivery).toHaveBeenCalledWith(
      expect.anything(),
      outboxId,
      expect.objectContaining({
        deliveryStatus: "delivered",
        status: "sent",
        deliveredAt: new Date("2026-07-25T00:01:00.000Z"),
      }),
    );
  });

  it("never downgrades a later delivery status", async () => {
    const repository = {
      findOutboxByProviderMessageId: vi.fn().mockResolvedValue({
        id: outboxId,
        conversationId: "7c57f3b8-2b13-48f5-8730-18ac71f490cd",
        status: "sent",
        deliveryStatus: "read",
        sentAt: new Date("2026-07-25T00:00:00.000Z"),
        deliveredAt: new Date("2026-07-25T00:01:00.000Z"),
        readAt: new Date("2026-07-25T00:02:00.000Z"),
        playedAt: null,
      }),
      lockConversation: vi.fn().mockResolvedValue(undefined),
      updateOutboxDelivery: vi.fn(),
    };
    const database = {
      transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) =>
        work({}),
      ),
    };
    const service = new MessageOutboxDeliveryStatusService(
      database as unknown as DatabaseService,
      repository as unknown as FeedbackOutboxRepository,
    );

    await expect(
      service.applyStatusChange(
        {
          providerMessageId: "wamid.1",
          status: "delivered",
          occurredAt: new Date("2026-07-25T00:03:00.000Z"),
        },
        "correlation-1",
      ),
    ).resolves.toEqual({ outcome: "unchanged", outboxId });
    expect(repository.updateOutboxDelivery).not.toHaveBeenCalled();
  });

  it("resolves an ambiguous attempt from a provider status observation", async () => {
    const repository = {
      findOutboxByProviderMessageId: vi.fn().mockResolvedValue({
        id: outboxId,
        conversationId: "7c57f3b8-2b13-48f5-8730-18ac71f490cd",
        status: "ambiguous",
        deliveryStatus: "pending",
        sentAt: null,
        deliveredAt: null,
        readAt: null,
        playedAt: null,
      }),
      lockConversation: vi.fn().mockResolvedValue(undefined),
      updateOutboxDelivery: vi.fn().mockResolvedValue(undefined),
    };
    const database = {
      transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) =>
        work({}),
      ),
    };
    const service = new MessageOutboxDeliveryStatusService(
      database as unknown as DatabaseService,
      repository as unknown as FeedbackOutboxRepository,
    );

    await service.applyStatusChange(
      {
        providerMessageId: "wamid.1",
        status: "sent",
        occurredAt: new Date("2026-07-25T00:01:00.000Z"),
      },
      "correlation-1",
    );

    expect(repository.updateOutboxDelivery).toHaveBeenCalledWith(
      expect.anything(),
      outboxId,
      expect.objectContaining({ deliveryStatus: "sent", status: "sent" }),
    );
  });

  it("reports unmatched provider message ids without writing", async () => {
    const repository = {
      findOutboxByProviderMessageId: vi.fn().mockResolvedValue(undefined),
      updateOutboxDelivery: vi.fn(),
    };
    const service = new MessageOutboxDeliveryStatusService(
      { transaction: vi.fn() } as unknown as DatabaseService,
      repository as unknown as FeedbackOutboxRepository,
    );

    await expect(
      service.applyStatusChange(
        {
          providerMessageId: "wamid.missing",
          status: "sent",
          occurredAt: new Date(),
        },
        "correlation-1",
      ),
    ).resolves.toEqual({ outcome: "unmatched" });
    expect(repository.updateOutboxDelivery).not.toHaveBeenCalled();
  });
});
