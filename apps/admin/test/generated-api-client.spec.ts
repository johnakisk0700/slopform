import { describe, expect, it } from "vitest";

import rebaseOnApiClient from "../openapi.transformer";

describe("OpenAPI generation path transformer", () => {
  it("rebases published API paths onto the shared client base URL", () => {
    const document = {
      paths: {
        "/api/v1/auth/session": { get: {} },
        "/api/v1/health/live": { get: {} },
      },
    };

    expect(Object.keys(rebaseOnApiClient(document).paths)).toStrictEqual([
      "/v1/auth/session",
      "/v1/health/live",
    ]);
  });

  it("fails generation when a published path leaves the API mount", () => {
    expect(() =>
      rebaseOnApiClient({ paths: { "/v1/auth/session": {} } }),
    ).toThrow('start with "/api/"');
  });
});
