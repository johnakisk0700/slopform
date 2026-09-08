import { describe, expect, it } from "vitest";

import { apiErrorMessage } from "../src/lib/api";

describe("apiErrorMessage", () => {
  it("uses the backend message when transport text is generic", () => {
    const cause = Object.assign(new Error("400 Bad Request"), {
      data: { message: "The campaign is paused" },
    });

    expect(apiErrorMessage(cause, "Try again")).toBe("The campaign is paused");
  });

  it("joins backend validation messages", () => {
    const cause = Object.assign(new Error("400 Bad Request"), {
      data: { message: ["campaignId must be a UUID", "body is invalid"] },
    });

    expect(apiErrorMessage(cause, "Try again")).toBe(
      "campaignId must be a UUID body is invalid",
    );
  });

  it("falls back safely for empty or non-error causes", () => {
    expect(apiErrorMessage(new Error(""), "Try again")).toBe("Try again");
    expect(apiErrorMessage("transport failure", "Try again")).toBe("Try again");
  });
});
