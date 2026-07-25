import { describe, expect, it } from "vitest";

import {
  WasenderWebhookParser,
  WasenderWebhookSignatureVerifier,
} from "./wasender.webhook.js";

describe("WasenderWebhookParser", () => {
  const parser = new WasenderWebhookParser();

  it("normalizes the documented personal-message object and second timestamp", () => {
    const [event] = parser.parse({
      event: "messages-personal.received",
      timestamp: 1_633_456_789,
      data: {
        messages: {
          key: {
            id: "inbound-id",
            fromMe: false,
            remoteJid: "555555555@lid",
            addressingMode: "pn",
            senderPn: "306900000000@s.whatsapp.net",
            cleanedSenderPn: "306900000000",
            senderLid: "555555555@lid",
            futureAddressingField: "ignored",
          },
          messageBody: "Hello",
          message: { conversation: "Hello" },
        },
      },
    });

    expect(event).toEqual({
      type: "message.observed",
      provider: "wasender",
      sourceEvent: "messages-personal.received",
      providerMessageId: "inbound-id",
      occurredAt: "2021-10-05T17:59:49.000Z",
      direction: "inbound",
      chatJid: "555555555@lid",
      chatKind: "personal",
      counterpartyPhoneE164: "+306900000000",
      text: "Hello",
      messageKey: expect.objectContaining({ id: "inbound-id" }),
    });
    expect(event?.messageKey).not.toHaveProperty("futureAddressingField");
  });

  it("accepts the documented upsert array and preserves outbound observation", () => {
    expect(
      parser.parse({
        event: "messages.upsert",
        timestamp: 1_747_775_431_467,
        data: {
          messages: [
            {
              key: {
                id: "outbound-id",
                fromMe: true,
                remoteJid: "306900000001@s.whatsapp.net",
              },
              messageBody: "Sent from WordPress or another linked client",
            },
          ],
        },
      }),
    ).toEqual([
      expect.objectContaining({
        type: "message.observed",
        providerMessageId: "outbound-id",
        occurredAt: "2025-05-20T21:10:31.467Z",
        direction: "outbound",
        chatKind: "personal",
        counterpartyPhoneE164: "+306900000001",
      }),
    ]);
  });

  it("maps every documented message status and never exposes sessionId", () => {
    const statuses = [
      "error",
      "pending",
      "sent",
      "delivered",
      "read",
      "played",
    ] as const;

    for (const [statusCode, status] of statuses.entries()) {
      const [event] = parser.parse({
        event: "messages.update",
        sessionId: "session-api-key-must-not-escape",
        timestamp: 1_747_775_431_467,
        data: {
          update: { status: statusCode },
          key: {
            id: `status-${statusCode}`,
            fromMe: true,
            remoteJid: "306900000001@s.whatsapp.net",
          },
        },
      });

      expect(event).toMatchObject({
        type: "message.status-changed",
        status,
        providerStatusCode: statusCode,
      });
      expect(event).not.toHaveProperty("sessionId");
    }
  });

  it("rejects unsupported events and malformed provider fields", () => {
    expect(() =>
      parser.parse({ event: "contacts.upsert", timestamp: 123, data: {} }),
    ).toThrow();
    expect(() =>
      parser.parse({
        event: "messages.update",
        timestamp: 123,
        data: {
          update: { status: 99 },
          key: { id: "id", fromMe: true, remoteJid: "jid" },
        },
      }),
    ).toThrow();
  });
});

describe("WasenderWebhookSignatureVerifier", () => {
  const verifier = new WasenderWebhookSignatureVerifier("s".repeat(32));

  it("compares the documented shared-secret header", () => {
    expect(verifier.verify("s".repeat(32))).toBe(true);
    expect(verifier.verify("x".repeat(32))).toBe(false);
    expect(verifier.verify(undefined)).toBe(false);
    expect(verifier.verify("x".repeat(513))).toBe(false);
  });
});
