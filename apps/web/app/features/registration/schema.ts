import * as z from "zod";

export const dietaryOptions: Array<{
  label: string;
  value: "none" | "vegetarian" | "vegan";
}> = [
  { label: "No preference", value: "none" },
  { label: "Vegetarian", value: "vegetarian" },
  { label: "Vegan", value: "vegan" },
];

export const registrationSchema = z.object({
  fullName: z.string().trim().min(2, "Enter your full name."),
  email: z.email("Enter a valid email address."),
  dietaryPreference: z.enum(["none", "vegetarian", "vegan"]),
  note: z.string().trim().max(500, "Keep the note under 500 characters."),
  privacyAccepted: z.literal(true, {
    error: "Confirm that you have read the current privacy notice.",
  }),
});

export type RegistrationInput = z.infer<typeof registrationSchema>;

export type RegistrationField = keyof RegistrationInput;

export function getRegistrationErrors(
  input: unknown,
): Partial<Record<RegistrationField, string>> {
  const result = registrationSchema.safeParse(input);

  if (result.success) {
    return {};
  }

  return result.error.issues.reduce<Partial<Record<RegistrationField, string>>>(
    (errors, issue) => {
      const field = issue.path[0];
      if (typeof field === "string" && !(field in errors)) {
        errors[field as RegistrationField] = issue.message;
      }
      return errors;
    },
    {},
  );
}
