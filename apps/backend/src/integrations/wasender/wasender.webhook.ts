import { timingSafeEqual } from "node:crypto";

import { Injectable } from "@nestjs/common";

import { normalizePhone } from "./wasender.jid.js";
import {
  type NormalizedWasenderWebhookEvent,
  type WasenderMessageKey,
  type WasenderMessageStatusCode,
  type WasenderWebhook,
  type WhatsAppChatKind,
  type WhatsAppDeliveryStatus,
  wasenderWebhookSchema,
} from "./wasender.schemas.js";

const STATUS_BY_CODE: Record<
  WasenderMessageStatusCode,
  WhatsAppDeliveryStatus
> = {
  0: "error",
  1: "pending",
  2: "sent",
  3: "delivered",
  4: "read",
  5: "played",
};

export class WasenderWebhookSignatureVerifier {
  constructor(private readonly secret: string) {}

  verify(signature: string | undefined): boolean {
    if (!signature || signature.length > 512) {
      return false;
    }

    const expected = Buffer.from(this.secret, "utf8");
    const actual = Buffer.from(signature, "utf8");

    return (
      expected.length === actual.length && timingSafeEqual(expected, actual)
    );
  }
}

@Injectable()
export class WasenderWebhookParser {
  parse(input: unknown): NormalizedWasenderWebhookEvent[] {
    const webhook = wasenderWebhookSchema.parse(input);
    const occurredAt = normalizeTimestamp(webhook.timestamp);

    if (webhook.event === "messages.update") {
      return [normalizeStatusEvent(webhook, occurredAt)];
    }

    const messages = Array.isArray(webhook.data.messages)
      ? webhook.data.messages
      : [webhook.data.messages];

    return messages.map(({ key, messageBody }) => ({
      type: "message.observed",
      provider: "wasender",
      sourceEvent: webhook.event,
      providerMessageId: key.id,
      occurredAt,
      direction: key.fromMe ? "outbound" : "inbound",
      chatJid: key.remoteJid,
      chatKind: classifyChat(key.remoteJid),
      counterpartyPhoneE164: resolveCounterpartyPhone(key),
      text: messageBody ?? null,
      messageKey: key,
    }));
  }
}

function normalizeStatusEvent(
  webhook: Extract<WasenderWebhook, { event: "messages.update" }>,
  occurredAt: string,
): NormalizedWasenderWebhookEvent {
  const statusCode = webhook.data.update.status;

  return {
    type: "message.status-changed",
    provider: "wasender",
    sourceEvent: "messages.update",
    providerMessageId: webhook.data.key.id,
    occurredAt,
    chatJid: webhook.data.key.remoteJid,
    status: STATUS_BY_CODE[statusCode],
    providerStatusCode: statusCode,
    messageKey: webhook.data.key,
  };
}

function normalizeTimestamp(timestamp: number): string {
  const milliseconds =
    timestamp < 1_000_000_000_000 ? timestamp * 1_000 : timestamp;
  return new Date(milliseconds).toISOString();
}

function classifyChat(remoteJid: string): WhatsAppChatKind {
  if (remoteJid.endsWith("@g.us")) {
    return "group";
  }

  if (remoteJid.endsWith("@newsletter")) {
    return "newsletter";
  }

  if (
    remoteJid.endsWith("@s.whatsapp.net") ||
    remoteJid.endsWith("@lid") ||
    /^\+?[1-9]\d{7,14}$/u.test(remoteJid)
  ) {
    return "personal";
  }

  return "unknown";
}

function resolveCounterpartyPhone(key: WasenderMessageKey): string | null {
  const candidates = key.fromMe
    ? [key.remoteJid]
    : [key.cleanedSenderPn, key.senderPn, key.remoteJid];

  for (const candidate of candidates) {
    const phone = normalizePhone(candidate);
    if (phone) {
      return phone;
    }
  }

  return null;
}
