import * as z from "zod";

export const EVENT_STATUSES = [
  "draft",
  "scheduled",
  "finished",
  "cancelled",
] as const;

export type EventStatus = (typeof EVENT_STATUSES)[number];

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
    status: z.enum(EVENT_STATUSES),
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
    items: z.array(eventSchema),
  })
  .strict();

export type EventAttendee = z.infer<typeof eventAttendeeSchema>;
export type EventSummary = z.infer<typeof eventSchema>;
export type EventDetail = z.infer<typeof eventDetailSchema>;

export function nextEventStatuses(status: EventStatus): readonly EventStatus[] {
  if (status === "draft") {
    return ["scheduled", "cancelled"];
  }
  if (status === "scheduled") {
    return ["finished", "cancelled"];
  }
  return [];
}

/** Local overview demo form — not the persisted stub-events API contract. */
export const eventPreviewSchema = z.object({
  name: z.string().trim().min(3, "Use at least three characters."),
  date: z.date({ error: "Choose a date." }),
});

export interface EventPreviewDraft {
  name: string;
  date: Date | null;
}

export type EventPreviewField = keyof EventPreviewDraft;

export function getEventPreviewErrors(
  input: unknown,
): Partial<Record<EventPreviewField, string>> {
  const result = eventPreviewSchema.safeParse(input);

  if (result.success) {
    return {};
  }

  return result.error.issues.reduce<Partial<Record<EventPreviewField, string>>>(
    (errors, issue) => {
      const field = issue.path[0];
      if ((field === "name" || field === "date") && !(field in errors)) {
        errors[field] = issue.message;
      }
      return errors;
    },
    {},
  );
}
