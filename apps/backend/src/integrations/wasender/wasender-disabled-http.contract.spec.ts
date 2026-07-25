import type { AddressInfo } from "node:net";

import type { NestExpressApplication } from "@nestjs/platform-express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@clerk/express", async (importOriginal) => {
  const original = await importOriginal<typeof import("@clerk/express")>();
  return {
    ...original,
    clerkMiddleware:
      () => (_request: unknown, _response: unknown, next: () => void) => {
        next();
      },
    getAuth: () => ({ isAuthenticated: false }),
  };
});

describe("disabled Wasender webhook HTTP contract", () => {
  let app: NestExpressApplication;
  let baseUrl: string;

  beforeAll(async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv(
      "DATABASE_URL",
      "postgresql://user:password@127.0.0.1:5432/join_the_six_test",
    );
    vi.stubEnv("REDIS_URL", "redis://127.0.0.1:6379");
    vi.stubEnv("WEB_ORIGIN", "http://localhost:3000");
    vi.stubEnv("CLERK_PUBLISHABLE_KEY", "pk_test_example");
    vi.stubEnv("CLERK_SECRET_KEY", "sk_test_example");
    vi.stubEnv("CLERK_ADMIN_USER_IDS", "user_admin123");
    vi.stubEnv("WASENDER_WEBHOOK_ENABLED", "false");
    vi.stubEnv("WASENDER_WEBHOOK_SECRET", "");
    vi.stubEnv("LOG_LEVEL", "silent");

    const { createHttpApplication } = await import("../../bootstrap-http.js");
    app = await createHttpApplication();
    await app.listen(0, "127.0.0.1");
    const address = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  }, 20_000);

  afterAll(async () => {
    await app?.close();
    vi.unstubAllEnvs();
  });

  it("does not mount the route or publish it in OpenAPI", async () => {
    const [routeResponse, openApiResponse] = await Promise.all([
      fetch(`${baseUrl}/api/v1/webhooks/wasender`, { method: "POST" }),
      fetch(`${baseUrl}/api/openapi.json`),
    ]);
    const document = (await openApiResponse.json()) as {
      paths: Record<string, Record<string, unknown>>;
    };

    expect(routeResponse.status).toBe(404);
    expect(document.paths).not.toHaveProperty("/api/v1/webhooks/wasender");
  });
});
