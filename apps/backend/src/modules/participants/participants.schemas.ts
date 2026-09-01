import { EVENT_STATUSES } from "@slopform/database";
import { createZodDto } from "nestjs-zod";
import { z } from "zod";

import { eventVenueSchema } from "../events/events.schemas.js";

export const participantIdSchema = z.object({ id: z.uuid() }).strict();

export const updateParticipantFeedbackOptInSchema = z
  .object({
    postEventFeedbackWhatsappOptIn: z.boolean(),
  })
  .strict();

export const participantSchema = z
  .object({
    id: z.uuid(),
    preferredName: z.string().nullable(),
    emailNormalized: z.string(),
    phoneE164: z.string().nullable(),
    ageBand: z.string().nullable(),
    preferredNeighborhood: z.string().nullable(),
    conversationStyle: z.number().int().nullable(),
    postEventFeedbackWhatsappOptIn: z.boolean(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

export const participantListSchema = z
  .object({
    items: z.array(participantSchema).max(500),
  })
  .strict();

export const participantEventHistoryItemSchema = z
  .object({
    eventId: z.uuid(),
    title: z.string(),
    startsAt: z.iso.datetime(),
    status: z.enum(EVENT_STATUSES),
    venue: eventVenueSchema.nullable(),
    present: z.boolean(),
    tableNo: z.number().int().nullable(),
  })
  .strict();

export const participantEventHistorySchema = z
  .object({
    items: z.array(participantEventHistoryItemSchema).max(500),
  })
  .strict();

export class ParticipantIdDto extends createZodDto(participantIdSchema) {}
export class UpdateParticipantFeedbackOptInDto extends createZodDto(
  updateParticipantFeedbackOptInSchema,
) {}
export class ParticipantDto extends createZodDto(participantSchema) {}
export class ParticipantListDto extends createZodDto(participantListSchema) {}
export class ParticipantEventHistoryDto extends createZodDto(
  participantEventHistorySchema,
) {}

export type UpdateParticipantFeedbackOptInInput = z.infer<
  typeof updateParticipantFeedbackOptInSchema
>;
export type ParticipantView = z.infer<typeof participantSchema>;
export type ParticipantListView = z.infer<typeof participantListSchema>;
export type ParticipantEventHistoryItemView = z.infer<
  typeof participantEventHistoryItemSchema
>;
export type ParticipantEventHistoryView = z.infer<
  typeof participantEventHistorySchema
>;
