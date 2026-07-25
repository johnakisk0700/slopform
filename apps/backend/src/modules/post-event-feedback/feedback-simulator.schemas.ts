import { createZodDto } from "nestjs-zod";
import { z } from "zod";

import { FEEDBACK_CONVERSATION_MESSAGE_MAX_TEXT_LENGTH } from "../conversations/feedback-conversation.schemas.js";

export const feedbackSimulatorPhoneSchema = z
  .string()
  .regex(/^\+[1-9]\d{7,14}$/u, "Expected an E.164 phone number");

export const injectFeedbackSimulatorMessageSchema = z
  .object({
    phoneE164: feedbackSimulatorPhoneSchema,
    text: z
      .string()
      .trim()
      .min(1)
      .max(FEEDBACK_CONVERSATION_MESSAGE_MAX_TEXT_LENGTH),
    fromMe: z.boolean().optional().default(false),
  })
  .strict();

export class InjectFeedbackSimulatorMessageDto extends createZodDto(
  injectFeedbackSimulatorMessageSchema,
) {}

export const injectFeedbackSimulatorMessageResponseSchema = z
  .object({
    ingressId: z.uuid(),
    inserted: z.boolean(),
  })
  .strict();

export class InjectFeedbackSimulatorMessageResponseDto extends createZodDto(
  injectFeedbackSimulatorMessageResponseSchema,
) {}

export const feedbackSimulatorThreadQuerySchema = z
  .object({
    phoneE164: feedbackSimulatorPhoneSchema,
  })
  .strict();

export class FeedbackSimulatorThreadQueryDto extends createZodDto(
  feedbackSimulatorThreadQuerySchema,
) {}

export const feedbackSimulatorThreadMessageSchema = z
  .object({
    id: z.string().min(1).max(200),
    source: z.enum(["ingress", "sim_outbound"]),
    direction: z.enum(["inbound", "outbound"]),
    text: z.string().min(1).max(FEEDBACK_CONVERSATION_MESSAGE_MAX_TEXT_LENGTH),
    occurredAt: z.iso.datetime(),
    ingressId: z.uuid().optional(),
    outboxId: z.uuid().optional(),
  })
  .strict();

export const feedbackSimulatorThreadResponseSchema = z
  .object({
    phoneE164: feedbackSimulatorPhoneSchema,
    messages: z.array(feedbackSimulatorThreadMessageSchema),
  })
  .strict();

export class FeedbackSimulatorThreadResponseDto extends createZodDto(
  feedbackSimulatorThreadResponseSchema,
) {}
