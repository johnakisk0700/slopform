import { describe, expect, it } from "vitest";
import {
  getRegistrationErrors,
  registrationSchema,
} from "../app/features/registration/schema";

const validRegistration = {
  fullName: "Ada Lovelace",
  email: "ada@example.com",
  dietaryPreference: "vegetarian",
  note: "",
  privacyAccepted: true,
} as const;

describe("registrationSchema", () => {
  it("accepts the documented public registration contract", () => {
    expect(registrationSchema.parse(validRegistration)).toEqual(
      validRegistration,
    );
  });

  it("returns field-addressable validation errors", () => {
    const errors = getRegistrationErrors({
      ...validRegistration,
      fullName: "A",
      email: "not-an-email",
      privacyAccepted: false,
    });

    expect(errors.fullName).toBeDefined();
    expect(errors.email).toBeDefined();
    expect(errors.privacyAccepted).toBeDefined();
  });
});
