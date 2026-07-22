import { describe, expect, it } from "vitest";

import { validatePublicEnvironment } from "../environment.public.js";
import {
  validateWebEnvironment,
  validateWebRuntimeConfig,
} from "../environment.server.js";

describe("web environment", () => {
  it("supplies local defaults for an empty build environment", () => {
    expect(validateWebEnvironment({})).toEqual({
      NUXT_API_BASE_INTERNAL: "http://localhost:4000/api/v1",
      NUXT_PUBLIC_API_BASE: "/api/v1",
    });
  });

  it("treats empty build values as missing", () => {
    expect(
      validateWebEnvironment({
        NUXT_API_BASE_INTERNAL: "  ",
        NUXT_PUBLIC_API_BASE: "",
      }),
    ).toEqual({
      NUXT_API_BASE_INTERNAL: "http://localhost:4000/api/v1",
      NUXT_PUBLIC_API_BASE: "/api/v1",
    });
  });

  it.each([
    "redis://api:4000/api/v1",
    "http://user:password@api:4000/api/v1",
    "http://api:4000/api/v1?token=value",
    "/api/v1",
  ])("rejects unsafe internal API base %s", (apiBaseInternal) => {
    expect(() =>
      validateWebEnvironment({ NUXT_API_BASE_INTERNAL: apiBaseInternal }),
    ).toThrow();
  });

  it.each(["/api/v1", "https://api.example.com/api/v1"])(
    "accepts public API base %s",
    (apiBase) => {
      expect(validatePublicEnvironment({ apiBase })).toEqual({ apiBase });
    },
  );

  it.each(["//example.com/api", "javascript:alert(1)", "/api/v1?token=value"])(
    "rejects unsafe public API base %s",
    (apiBase) => {
      expect(() => validatePublicEnvironment({ apiBase })).toThrow();
    },
  );

  it("validates the resolved Nitro runtime config", () => {
    expect(() =>
      validateWebRuntimeConfig({
        apiBaseInternal: "http://api:4000/api/v1",
        public: { apiBase: "/api/v1" },
      }),
    ).not.toThrow();

    expect(() =>
      validateWebRuntimeConfig({
        apiBaseInternal: "",
        public: { apiBase: "/api/v1" },
      }),
    ).toThrow();
  });
});
