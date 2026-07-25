import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readAdminFile(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../${relativePath}`, import.meta.url)),
    "utf8",
  );
}

describe("admin authentication delivery contract", () => {
  it("mounts Clerk only when the Vite publishable key is configured", () => {
    const main = readAdminFile("src/main.tsx");

    expect(main).toContain("<ClerkProvider");
    expect(main).toContain("env.clerkPublishableKey");
    expect(main).toContain('kind="configuration"');
  });

  it("protects the admin shell behind the backend authorization check", () => {
    const app = readAdminFile("src/App.tsx");
    const guard = readAdminFile("src/components/admin/RequireAdmin.tsx");

    expect(app).toContain("<Route element={<RequireAdmin />}>");
    expect(guard).toContain('from "../../api/generated/auth"');
    expect(guard).toContain("useGetAuthSession");
    expect(guard).toContain("status === 401 || status === 403");
  });

  it("keeps the local bypass explicit and development-only", () => {
    const environment = readAdminFile("src/lib/env.ts");
    const main = readAdminFile("src/main.tsx");

    expect(environment).toContain("VITE_AUTH_DEV_BYPASS");
    expect(environment).toContain("!environment.isDevelopment");
    expect(main).toContain("env.authDevBypass");
  });

  it("injects Clerk's session token into the shared API facade", () => {
    const api = readAdminFile("src/lib/api.ts");

    expect(api).toContain('import { getToken } from "@clerk/react"');
    expect(api).toContain('headers.set("Authorization", `Bearer ${token}`)');
    expect(api).toContain('headers.delete("Authorization")');
  });
});
