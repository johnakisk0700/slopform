import { beforeAll, describe, expect, it } from "vitest";

let apiErrorMessage: (cause: unknown, fallback: string) => string;

beforeAll(async () => {
  // Runtime-only specifier: keeps this node test project's type program free of
  // the app module's browser/Clerk deps while vitest still loads the real export.
  const moduleUrl = new URL("../src/lib/api.ts", import.meta.url).href;
  const module = (await import(moduleUrl)) as {
    apiErrorMessage: (cause: unknown, fallback: string) => string;
  };
  apiErrorMessage = module.apiErrorMessage;
});

describe("apiErrorMessage", () => {
  it("prefers the backend response message over the transport error", () => {
    const cause = Object.assign(
      new Error(
        '[POST] "/v1/feedback/campaigns/campaign-1/summary": 400 Bad Request',
      ),
      {
        data: {
          message:
            "Feedback campaign summaries are disabled while the simulator is enabled",
        },
      },
    );

    expect(apiErrorMessage(cause, "fallback")).toBe(
      "Feedback campaign summaries are disabled while the simulator is enabled",
    );
  });

  it("joins backend validation messages", () => {
    const cause = Object.assign(new Error("400 Bad Request"), {
      data: { message: ["campaignId must be a UUID", "body is invalid"] },
    });

    expect(apiErrorMessage(cause, "fallback")).toBe(
      "campaignId must be a UUID body is invalid",
    );
  });

  it("returns the message from an Error with a message", () => {
    expect(apiErrorMessage(new Error("boom"), "fallback")).toBe("boom");
  });

  it("returns the fallback for an Error with an empty message", () => {
    expect(apiErrorMessage(new Error(""), "fallback")).toBe("fallback");
  });

  it("returns the fallback for a non-Error cause", () => {
    expect(apiErrorMessage("boom", "fallback")).toBe("fallback");
  });
});
