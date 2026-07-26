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
