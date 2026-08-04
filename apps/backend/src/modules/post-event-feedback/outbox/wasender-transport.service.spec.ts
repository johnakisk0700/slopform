import { describe, expect, it, vi } from "vitest";

import {
  WasenderClient,
  WasenderClientError,
} from "../../../integrations/wasender/wasender.client.js";
import { WasenderFeedbackTransport } from "./wasender-transport.service.js";

describe("WasenderFeedbackTransport", () => {
  it("maps acceptance and captures post-acceptance provider info", async () => {
    const client = {
      sendText: vi.fn().mockResolvedValue({
        providerLogId: 42,
        recipient: "306900000001@s.whatsapp.net",
        providerStatus: "sent",
      }),
      getMessageInfo: vi.fn().mockResolvedValue({
        providerLogId: 42,
        providerMessageId: "wamid.1",
        remoteJid: "306900000001@s.whatsapp.net",
        messageKey: {
          id: "wamid.1",
          remoteJid: "306900000001@s.whatsapp.net",
          fromMe: true,
        },
        occurredAt: "2026-07-25T00:00:00.000Z",
        status: "sent",
        providerStatusCode: 2,
      }),
    };
    const transport = new WasenderFeedbackTransport(
      client as unknown as WasenderClient,
    );

    await expect(
      transport.sendText({
        to: "+306900000001",
        text: "γεια",
        outboxId: "66de52a8-1a26-4cbb-b8d1-fcf8bdc2dd51",
      }),
    ).resolves.toEqual({
      outcome: "accepted",
      providerLogId: "42",
      providerStatus: "sent",
      providerMessageId: "wamid.1",
    });
    expect(client.sendText).toHaveBeenCalledTimes(1);
    expect(client.getMessageInfo).toHaveBeenCalledWith(42);
  });

  it("surfaces unknown outcomes without retrying sendText", async () => {
    const client = {
      sendText: vi
        .fn()
        .mockRejectedValue(
          new WasenderClientError("timeout", "timeout", "send-text", "unknown"),
        ),
      getMessageInfo: vi.fn(),
    };
    const transport = new WasenderFeedbackTransport(
      client as unknown as WasenderClient,
    );

    await expect(
      transport.sendText({
        to: "+306900000001",
        text: "γεια",
        outboxId: "66de52a8-1a26-4cbb-b8d1-fcf8bdc2dd51",
      }),
    ).resolves.toEqual({
      outcome: "unknown",
      reason: "timeout",
    });
    expect(client.sendText).toHaveBeenCalledTimes(1);
    expect(client.getMessageInfo).not.toHaveBeenCalled();
  });

  it("keeps provider acceptance when the follow-up info is not linked yet", async () => {
    const client = {
      sendText: vi.fn().mockResolvedValue({
        providerLogId: 42,
        recipient: "306900000001@s.whatsapp.net",
        providerStatus: "sent",
      }),
      getMessageInfo: vi.fn().mockRejectedValue(new Error("not linked yet")),
    };
    const transport = new WasenderFeedbackTransport(
      client as unknown as WasenderClient,
    );

    await expect(
      transport.sendText({
        to: "+306900000001",
        text: "γεια",
        outboxId: "66de52a8-1a26-4cbb-b8d1-fcf8bdc2dd51",
      }),
    ).resolves.toEqual({
      outcome: "accepted",
      providerLogId: "42",
      providerStatus: "sent",
    });
    expect(client.sendText).toHaveBeenCalledTimes(1);
    expect(client.getMessageInfo).toHaveBeenCalledWith(42);
  });

  it("maps non-5xx rejections as not-accepted", async () => {
    const client = {
      sendText: vi
        .fn()
        .mockRejectedValue(
          new WasenderClientError(
            "rejected",
            "http",
            "send-text",
            "not-accepted",
            400,
          ),
        ),
      getMessageInfo: vi.fn(),
    };
    const transport = new WasenderFeedbackTransport(
      client as unknown as WasenderClient,
    );

    await expect(
      transport.sendText({
        to: "+306900000001",
        text: "γεια",
        outboxId: "66de52a8-1a26-4cbb-b8d1-fcf8bdc2dd51",
      }),
    ).resolves.toEqual({
      outcome: "not-accepted",
      reason: "http",
    });
  });
});
