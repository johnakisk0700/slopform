import { createZodDto } from "nestjs-zod";
import { z } from "zod";

import { EVENT_STATUSES } from "@join-the-six/database";

export const EVENT_STATUS_TRANSITIONS = {
  draft: ["scheduled", "cancelled"],
  scheduled: ["finished", "cancelled"],
  finished: [],
  cancelled: [],
} as const satisfies Record<
  (typeof EVENT_STATUSES)[number],
  readonly (typeof EVENT_STATUSES)[number][]
>;

export const eventStatusSchema = z.enum(EVENT_STATUSES);
export const eventPrincipalSchema = z.string().min(1).max(200);
export const eventCorrelationIdSchema = z.string().min(1).max(128);

export const createEventSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    startsAt: z.iso.datetime(),
  })
  .strict();

export const updateEventSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    startsAt: z.iso.datetime().optional(),
  })
  .strict()
  .refine(
    (value) => value.title !== undefined || value.startsAt !== undefined,
    {
      message: "At least one field is required",
    },
  );

export const transitionEventStatusSchema = z
  .object({
    status: eventStatusSchema,
  })
  .strict();

export const eventIdSchema = z.object({ id: z.uuid() }).strict();

export const upsertEventAttendeeSchema = z
  .object({
    participantId: z.uuid(),
    tableNo: z.number().int().min(1).max(999).nullable().optional(),
    present: z.boolean().optional(),
  })
  .strict();

export const updateEventAttendeeSchema = z
  .object({
    tableNo: z.number().int().min(1).max(999).nullable().optional(),
    present: z.boolean().optional(),
  })
  .strict()
  .refine(
    (value) => value.tableNo !== undefined || value.present !== undefined,
    { message: "At least one field is required" },
  );

export const eventAttendeeIdSchema = z
  .object({
    id: z.uuid(),
    attendeeId: z.uuid(),
  })
  .strict();

export const eventAttendeeSchema = z
  .object({
    id: z.uuid(),
    eventId: z.uuid(),
    participantId: z.uuid(),
    preferredName: z.string().nullable(),
    emailNormalized: z.string(),
    tableNo: z.number().int().nullable(),
    present: z.boolean(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

export const eventSchema = z
  .object({
    id: z.uuid(),
    title: z.string(),
    startsAt: z.iso.datetime(),
    status: eventStatusSchema,
    attendeeCount: z.number().int().nonnegative(),
    presentCount: z.number().int().nonnegative(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

export const eventDetailSchema = eventSchema
  .extend({
    attendees: z.array(eventAttendeeSchema),
  })
  .strict();

export const eventListSchema = z
  .object({
    items: z.array(eventSchema).max(200),
  })
  .strict();

export const feedbackCandidateSchema = z
  .object({
    participantId: z.uuid(),
    displayName: z.string().min(1).max(120),
  })
  .strict();

export const feedbackCandidatesSchema = z
  .object({
    items: z.array(feedbackCandidateSchema),
  })
  .strict();

export const feedbackCandidatesQuerySchema = z
  .object({
    respondentParticipantId: z.uuid(),
  })
  .strict();

export class CreateEventDto extends createZodDto(createEventSchema) {}
export class UpdateEventDto extends createZodDto(updateEventSchema) {}
export class TransitionEventStatusDto extends createZodDto(
  transitionEventStatusSchema,
) {}
export class EventIdDto extends createZodDto(eventIdSchema) {}
export class UpsertEventAttendeeDto extends createZodDto(
  upsertEventAttendeeSchema,
) {}
export class UpdateEventAttendeeDto extends createZodDto(
  updateEventAttendeeSchema,
) {}
export class EventAttendeeIdDto extends createZodDto(eventAttendeeIdSchema) {}
export class EventAttendeeDto extends createZodDto(eventAttendeeSchema) {}
export class EventDto extends createZodDto(eventSchema) {}
export class EventDetailDto extends createZodDto(eventDetailSchema) {}
export class EventListDto extends createZodDto(eventListSchema) {}
const EventPrincipalDtoBase = createZodDto(
  eventPrincipalSchema,
) as unknown as new () => object;
const EventCorrelationIdDtoBase = createZodDto(
  eventCorrelationIdSchema,
) as unknown as new () => object;
export class EventPrincipalDto extends EventPrincipalDtoBase {}
export class EventCorrelationIdDto extends EventCorrelationIdDtoBase {}
export class FeedbackCandidatesDto extends createZodDto(
  feedbackCandidatesSchema,
) {}
export class FeedbackCandidatesQueryDto extends createZodDto(
  feedbackCandidatesQuerySchema,
) {}

export type CreateEventInput = z.infer<typeof createEventSchema>;
export type UpdateEventInput = z.infer<typeof updateEventSchema>;
export type TransitionEventStatusInput = z.infer<
  typeof transitionEventStatusSchema
>;
export type UpsertEventAttendeeInput = z.infer<
  typeof upsertEventAttendeeSchema
>;
export type UpdateEventAttendeeInput = z.infer<
  typeof updateEventAttendeeSchema
>;
export type EventView = z.infer<typeof eventSchema>;
export type EventDetailView = z.infer<typeof eventDetailSchema>;
export type EventListView = z.infer<typeof eventListSchema>;
export type EventAttendeeView = z.infer<typeof eventAttendeeSchema>;
export type FeedbackCandidate = z.infer<typeof feedbackCandidateSchema>;
export type FeedbackCandidatesView = z.infer<typeof feedbackCandidatesSchema>;
