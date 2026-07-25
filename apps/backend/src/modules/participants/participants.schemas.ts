import { createZodDto } from "nestjs-zod";
import { z } from "zod";

export const participantPrincipalSchema = z.string().min(1).max(200);
export const participantCorrelationIdSchema = z.string().min(1).max(128);

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

export class ParticipantIdDto extends createZodDto(participantIdSchema) {}
export class UpdateParticipantFeedbackOptInDto extends createZodDto(
  updateParticipantFeedbackOptInSchema,
) {}
export class ParticipantDto extends createZodDto(participantSchema) {}
export class ParticipantListDto extends createZodDto(participantListSchema) {}
const ParticipantPrincipalDtoBase = createZodDto(
  participantPrincipalSchema,
) as unknown as new () => object;
const ParticipantCorrelationIdDtoBase = createZodDto(
  participantCorrelationIdSchema,
) as unknown as new () => object;
export class ParticipantPrincipalDto extends ParticipantPrincipalDtoBase {}
export class ParticipantCorrelationIdDto extends ParticipantCorrelationIdDtoBase {}

export type UpdateParticipantFeedbackOptInInput = z.infer<
  typeof updateParticipantFeedbackOptInSchema
>;
export type ParticipantView = z.infer<typeof participantSchema>;
export type ParticipantListView = z.infer<typeof participantListSchema>;
