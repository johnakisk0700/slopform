import * as z from "zod";

/** Local overview demo form — not the persisted stub-events API contract. */
export const eventPreviewSchema = z.object({
  name: z.string().trim().min(3, "Use at least three characters."),
  date: z.date({ error: "Choose a date." }),
});

export interface EventPreviewDraft {
  name: string;
  date: Date | null;
}

type EventPreviewField = keyof EventPreviewDraft;

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
