import { ConfigService } from "@nestjs/config";
import { describe, expect, it } from "vitest";

import type { Environment } from "../config/environment.js";
import { AuthConfigService } from "./auth-config.service.js";

function createConfig(
  overrides?: Partial<Environment>,
): ConfigService<Environment, true> {
  const values = {
    CLERK_ADMIN_USER_IDS: ["user_admin123"],
    CLERK_PUBLISHABLE_KEY: "pk_test_example",
    CLERK_SECRET_KEY: "sk_test_example",
    AUTH_DEV_BYPASS: false,
    WEB_ORIGIN: ["http://localhost:3000"],
    ...overrides,
  };

  return {
    get: (key: keyof typeof values) => values[key],
  } as unknown as ConfigService<Environment, true>;
}

describe("AuthConfigService", () => {
  it("fails the HTTP composition when Clerk or admin policy is missing", () => {
    expect(
      () =>
        new AuthConfigService(
          createConfig({ CLERK_ADMIN_USER_IDS: undefined }),
        ),
    ).toThrow(/CLERK_ADMIN_USER_IDS/);
  });

  it("keeps admin authorization server-side", () => {
    const config = new AuthConfigService(createConfig());

    expect(config.isAdminUser("user_admin123")).toBe(true);
    expect(config.isAdminUser("user_someoneElse123")).toBe(false);
    expect(config.authorizedParties).toEqual(["http://localhost:3000"]);
  });

  it("starts without Clerk configuration only for the explicit dev bypass", () => {
    const config = new AuthConfigService(
      createConfig({
        AUTH_DEV_BYPASS: true,
        CLERK_ADMIN_USER_IDS: undefined,
        CLERK_PUBLISHABLE_KEY: undefined,
        CLERK_SECRET_KEY: undefined,
      }),
    );

    expect(config.devBypassEnabled).toBe(true);
    expect(config.clerkClient).toBeUndefined();
  });
});
