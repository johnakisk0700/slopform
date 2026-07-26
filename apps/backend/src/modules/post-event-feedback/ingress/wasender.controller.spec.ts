import {
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { CorrelationIdDto } from "../../../infrastructure/auth/auth.schemas.js";
import type { WasenderWebhookDto } from "../../../integrations/wasender/wasender.schemas.js";
import {
  WasenderWebhookParser,
  WasenderWebhookSignatureVerifier,
} from "../../../integrations/wasender/wasender.webhook.js";
import type { MessageOutboxDeliveryStatusService } from "../outbox/delivery-status.service.js";
import {
  PostEventFeedbackEnqueueError,
  type PostEventFeedbackIngressService,
} from "./ingress.service.js";
import { WasenderWebhookController } from "./wasender.controller.js";

const secret = "webhook-secret-that-is-at-least-32-characters";
const correlationId = "correlation-1" as unknown as CorrelationIdDto;

function upsert(
  key: Record<string, unknown>,
  messageBody?: string,
): WasenderWebhookDto {
  return {
    event: "messages.upsert",
    timestamp: 1_747_775_431_467,
    data: { messages: { key, messageBody } },
  } as unknown as WasenderWebhookDto;
}

describe("WasenderWebhookController", () => {
  beforeAll(() => {
    Logger.overrideLogger(false);
  });

  it("records one durable ingress row per observed personal message", async () => {
    const { controller, ingress } = createController();

    await expect(
      controller.receive(
        secret,
        upsert(
          {
            id: "provider-message-1",
            remoteJid: "306900000001@s.whatsapp.net",
            fromMe: false,
          },
          "  Πέρασα τέλεια  ",
        ),
        correlationId,
      ),
    ).resolves.toEqual({
      received: true,
      eventCount: 1,
      recordedCount: 1,
      skippedCount: 0,
      deferredCount: 0,
    });

    expect(ingress.recordObservedMessage).toHaveBeenCalledWith(
      {
        providerMessageId: "provider-message-1",
        chatJid: "306900000001@s.whatsapp.net",
        direction: "inbound",
        phoneE164: "+306900000001",
        text: "Πέρασα τέλεια",
        observedAt: new Date(1_747_775_431_467),
      },
      "correlation-1",
    );
  });

  it("rejects an invalid signature before touching the durable boundary", async () => {
    const { controller, ingress } = createController();

    await expect(
      controller.receive(
        "x".repeat(32),
        upsert({
          id: "provider-message-1",
          remoteJid: "306900000001@s.whatsapp.net",
          fromMe: false,
        }),
        correlationId,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(ingress.recordObservedMessage).not.toHaveBeenCalled();
  });

  it("never stores group or newsletter traffic from the shared session", async () => {
    const { controller, ingress } = createController();

    await expect(
      controller.receive(
        secret,
        upsert(
          {
            id: "provider-message-2",
            remoteJid: "120363000000000000@g.us",
            fromMe: false,
          },
          "μήνυμα σε γκρουπ",
        ),
        correlationId,
      ),
    ).resolves.toMatchObject({ recordedCount: 0, skippedCount: 1 });
    expect(ingress.recordObservedMessage).not.toHaveBeenCalled();
  });

  it("counts delivery-status events instead of discarding them", async () => {
    const { controller, ingress, deliveryStatus } = createController();

    await expect(
      controller.receive(
        secret,
        {
          event: "messages.update",
          timestamp: 1_747_775_431_467,
          data: {
            update: { status: 3 },
            key: {
              id: "provider-message-3",
              remoteJid: "306900000001@s.whatsapp.net",
              fromMe: true,
            },
          },
        } as unknown as WasenderWebhookDto,
        correlationId,
      ),
    ).resolves.toMatchObject({ recordedCount: 0, deferredCount: 1 });
    expect(ingress.recordObservedMessage).not.toHaveBeenCalled();
    expect(deliveryStatus.applyStatusChange).toHaveBeenCalledWith(
      {
        providerMessageId: "provider-message-3",
        status: "delivered",
        occurredAt: new Date(1_747_775_431_467),
      },
      "correlation-1",
    );
  });

  it("asks the provider to redeliver when the message could not be queued", async () => {
    const { controller } = createController(
      new PostEventFeedbackEnqueueError("ingress-1"),
    );

    await expect(
      controller.receive(
        secret,
        upsert(
          {
            id: "provider-message-4",
            remoteJid: "306900000001@s.whatsapp.net",
            fromMe: false,
          },
          "Πέρασα τέλεια",
        ),
        correlationId,
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});

function createController(failure?: Error): {
  controller: WasenderWebhookController;
  ingress: { recordObservedMessage: ReturnType<typeof vi.fn> };
  deliveryStatus: { applyStatusChange: ReturnType<typeof vi.fn> };
} {
  const ingress = {
    recordObservedMessage: failure
      ? vi.fn().mockRejectedValue(failure)
      : vi.fn().mockResolvedValue({ ingressId: "ingress-1", inserted: true }),
  };
  const deliveryStatus = {
    applyStatusChange: vi.fn().mockResolvedValue({ outcome: "unmatched" }),
  };

  return {
    controller: new WasenderWebhookController(
      new WasenderWebhookSignatureVerifier(secret),
      new WasenderWebhookParser(),
      ingress as unknown as PostEventFeedbackIngressService,
      deliveryStatus as unknown as MessageOutboxDeliveryStatusService,
    ),
    ingress,
    deliveryStatus,
  };
}
