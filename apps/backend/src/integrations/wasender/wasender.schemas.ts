import { createZodDto } from "nestjs-zod";
import { z } from "zod";

const providerIdentifierSchema = z.string().trim().min(1).max(512);
const providerJidSchema = z.string().trim().min(1).max(512);

export const whatsAppE164Schema = z
  .string()
  .regex(/^\+[1-9]\d{7,14}$/u, "Expected an E.164 phone number");

export const wasenderMessageStatusCodeSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
]);

export const wasenderMessageKeySchema = z.object({
  id: providerIdentifierSchema,
  fromMe: z.boolean(),
  remoteJid: providerJidSchema,
  addressingMode: z.string().trim().min(1).max(32).optional(),
  senderPn: providerJidSchema.optional(),
  cleanedSenderPn: z.string().trim().min(1).max(32).optional(),
  senderLid: providerJidSchema.optional(),
  participant: providerJidSchema.optional(),
});

const wasenderWebhookMessageSchema = z.object({
  key: wasenderMessageKeySchema,
  messageBody: z.string().max(65_536).nullable().optional(),
  message: z.record(z.string(), z.unknown()).optional(),
});

const webhookMessagesSchema = z.union([
  wasenderWebhookMessageSchema,
  z.array(wasenderWebhookMessageSchema).min(1).max(100),
]);

const webhookTimestampSchema = z
  .number()
  .int()
  .positive()
  .refine((value) => {
    const milliseconds = value < 1_000_000_000_000 ? value * 1_000 : value;
    return !Number.isNaN(new Date(milliseconds).valueOf());
  }, "Expected a Unix timestamp in seconds or milliseconds");

const personalMessageWebhookSchema = z
  .object({
    event: z.literal("messages-personal.received"),
    timestamp: webhookTimestampSchema,
    sessionId: providerIdentifierSchema.optional(),
    data: z
      .object({
        messages: webhookMessagesSchema,
      })
      .strict(),
  })
  .strict();

const messageUpsertWebhookSchema = z
  .object({
    event: z.literal("messages.upsert"),
    timestamp: webhookTimestampSchema,
    sessionId: providerIdentifierSchema.optional(),
    data: z
      .object({
        messages: webhookMessagesSchema,
      })
      .strict(),
  })
  .strict();

const messageStatusWebhookSchema = z
  .object({
    event: z.literal("messages.update"),
    timestamp: webhookTimestampSchema,
    // Wasender's example labels this as the API key. It is intentionally
    // validated but never copied into the normalized event or logs.
    sessionId: providerIdentifierSchema.optional(),
    data: z
      .object({
        update: z.object({ status: wasenderMessageStatusCodeSchema }).strict(),
        key: wasenderMessageKeySchema,
      })
      .strict(),
  })
  .strict();

export const wasenderWebhookSchema = z.discriminatedUnion("event", [
  personalMessageWebhookSchema,
  messageUpsertWebhookSchema,
  messageStatusWebhookSchema,
]);

const wasenderWebhookDtoSchema = z
  .object({
    event: z.enum([
      "messages-personal.received",
      "messages.upsert",
      "messages.update",
    ]),
    timestamp: webhookTimestampSchema,
    sessionId: providerIdentifierSchema.optional(),
    data: z.unknown(),
  })
  .strict()
  .superRefine((value, context) => {
    const result = wasenderWebhookSchema.safeParse(value);
    if (!result.success) {
      context.addIssue({
        code: "custom",
        message: "Invalid Wasender webhook payload",
      });
    }
  });

export const wasenderWebhookAcknowledgementSchema = z
  .object({
    received: z.literal(true),
    eventCount: z.number().int().positive(),
  })
  .strict();

export class WasenderWebhookDto extends createZodDto(
  wasenderWebhookDtoSchema,
) {}
export class WasenderWebhookAcknowledgementDto extends createZodDto(
  wasenderWebhookAcknowledgementSchema,
) {}

export type WasenderMessageStatusCode = z.infer<
  typeof wasenderMessageStatusCodeSchema
>;
export type WasenderMessageKey = z.infer<typeof wasenderMessageKeySchema>;
export type WasenderWebhook = z.infer<typeof wasenderWebhookSchema>;

export type WhatsAppDeliveryStatus =
  "error" | "pending" | "sent" | "delivered" | "read" | "played";

export type WhatsAppChatKind = "personal" | "group" | "newsletter" | "unknown";

export type NormalizedWasenderWebhookEvent =
  | {
      readonly type: "message.observed";
      readonly provider: "wasender";
      readonly sourceEvent: "messages-personal.received" | "messages.upsert";
      readonly providerMessageId: string;
      readonly occurredAt: string;
      readonly direction: "inbound" | "outbound";
      readonly chatJid: string;
      readonly chatKind: WhatsAppChatKind;
      readonly counterpartyPhoneE164: string | null;
      readonly text: string | null;
      readonly messageKey: WasenderMessageKey;
    }
  | {
      readonly type: "message.status-changed";
      readonly provider: "wasender";
      readonly sourceEvent: "messages.update";
      readonly providerMessageId: string;
      readonly occurredAt: string;
      readonly chatJid: string;
      readonly status: WhatsAppDeliveryStatus;
      readonly providerStatusCode: WasenderMessageStatusCode;
      readonly messageKey: WasenderMessageKey;
    };
