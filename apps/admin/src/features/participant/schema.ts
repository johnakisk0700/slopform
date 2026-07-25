import * as z from "zod";

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
    items: z.array(participantSchema),
  })
  .strict();

export type Participant = z.infer<typeof participantSchema>;
